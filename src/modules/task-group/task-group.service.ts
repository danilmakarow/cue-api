import { ForbiddenException, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { CreateTaskGroupDto } from './dtos';
import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import { Calendar, TaskGroup } from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  TaskDatabaseService,
  TaskGroupDatabaseService,
} from '@/modules/database/services';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import { RecurrenceRuleService } from '@/modules/recurrence-rule/recurrence-rule.service';
import { SyncStateService } from '@/modules/sync/sync-state.service';

/**
 * Fields the REST layer may change on an existing task group.
 * `recurrence` set to a DTO adds or replaces the group's default inline config;
 * set to `null` removes it. `requiresCompletion` set to a boolean is the group
 * default inherited by tasks (task-wins); `null` clears the group default.
 * `color` set to a value sets the default; `null` clears it. All keys optional.
 */
export interface UpdateTaskGroupInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  requiresCompletion?: boolean | null;
  recurrence?: CreateRecurrenceRuleDto | null;
}

/**
 * Service handling task-group CRUD and ordering logic. Groups are calendar-owned
 * buckets of tasks; every read/write asserts the acting user owns the calendar
 * the group lives in. Groups are not soft-deleted — `Task.groupId` is SET NULL on
 * removal (per the schema), so deleting a group orphans its tasks rather than
 * cascading.
 */
@Injectable()
export class TaskGroupService {
  constructor(
    private readonly taskGroupDatabaseService: TaskGroupDatabaseService,
    private readonly calendarDatabaseService: CalendarDatabaseService,
    private readonly taskDatabaseService: TaskDatabaseService,
    private readonly syncStateService: SyncStateService,
  ) {}

  /**
   * Creates a TaskGroup inside the calendar named by `dto.calendarId` after
   * asserting the calendar belongs to the user. When `dto.recurrence` is provided,
   * it is stored inline as the group's default `recurrenceConfig` (ADR 0054).
   * `requiresCompletion` / `color` are stored as the group defaults. Built via
   * `createInstance` and persisted with `.save()`.
   */
  @Transactional()
  async create(userId: string, dto: CreateTaskGroupDto): Promise<TaskGroup> {
    await this.ensureCalendarOwnedByUser(dto.calendarId, userId);

    const recurrenceConfig = dto.recurrence
      ? RecurrenceRuleService.toConfig(dto.recurrence)
      : null;

    const group = this.taskGroupDatabaseService.createInstance({
      calendarId: dto.calendarId,
      name: dto.name,
      color: dto.color ?? null,
      icon: dto.icon ?? null,
      requiresCompletion: dto.requiresCompletion ?? null,
      defaultNotificationStrategyId: dto.defaultNotificationStrategyId ?? null,
      recurrenceConfig,
      sortOrder: dto.sortOrder ?? 0,
    });

    const saved = await this.taskGroupDatabaseService.save(group);

    await this.syncStateService.bump(userId);

    return saved;
  }

  /**
   * Updates a TaskGroup's mutable fields (name, color, icon, sortOrder,
   * requiresCompletion) and its default inline recurrence config. When
   * `changes.recurrence` is a DTO the config is set/replaced; when `null` it is
   * cleared; when `undefined` it is left unchanged (ADR 0054). Short-circuits when
   * nothing changed.
   */
  @Transactional()
  async update(
    userId: string,
    groupId: string,
    changes: UpdateTaskGroupInput,
  ): Promise<TaskGroup> {
    const group = await this.findOwnedGroup(userId, groupId);

    const nextName = changes.name ?? group.name;
    const nextColor = changes.color !== undefined ? changes.color : group.color;
    const nextIcon = changes.icon !== undefined ? changes.icon : group.icon;
    const nextSortOrder =
      changes.sortOrder !== undefined ? changes.sortOrder : group.sortOrder;
    const nextRequiresCompletion =
      changes.requiresCompletion !== undefined
        ? changes.requiresCompletion
        : group.requiresCompletion;

    const recurrenceChanged = this.applyRecurrenceUpdate(group, changes);

    // Capture effective-settings-affecting diffs BEFORE mutating the row, so the
    // member-task touch below fires exactly when a group change alters what its
    // tasks inherit (color / requiresCompletion / recurrence — task-wins).
    const colorChanged = nextColor !== group.color;
    const requiresCompletionChanged =
      nextRequiresCompletion !== group.requiresCompletion;

    const hasFieldChanges =
      nextName !== group.name ||
      colorChanged ||
      nextIcon !== group.icon ||
      nextSortOrder !== group.sortOrder ||
      requiresCompletionChanged;

    if (hasFieldChanges) {
      group.name = nextName;
      group.color = nextColor;
      group.icon = nextIcon;
      group.sortOrder = nextSortOrder;
      group.requiresCompletion = nextRequiresCompletion;
    }

    if (hasFieldChanges || recurrenceChanged) {
      await this.taskGroupDatabaseService.save(group);

      // A change to inherited settings must surface the member tasks in the
      // delta even though their own rows were not written.
      if (colorChanged || requiresCompletionChanged || recurrenceChanged) {
        await this.taskDatabaseService.touchAllInGroup(group.id);
      }

      await this.syncStateService.bump(userId);
    }

    return group;
  }

  /**
   * Bulk-reorders task groups by assigning each group a `sortOrder` equal to its
   * index in `groupIds`, transactionally — replacing N racy single PATCHes. Loads
   * every referenced group, asserts ALL of them belong to a calendar the user owns
   * (throws 404 if any id is missing, 403 if any belongs to another user) BEFORE
   * mutating, then saves the changed rows in one transaction so a partial reorder
   * can never persist. Returns the reordered groups in the requested order.
   */
  @Transactional()
  async reorder(userId: string, groupIds: string[]): Promise<TaskGroup[]> {
    const groups = await this.taskGroupDatabaseService.findAll({
      where: { id: In(groupIds) },
    });

    if (groups.length !== groupIds.length) {
      throw new EntityNotFoundException(TaskGroup);
    }

    const ownedCalendarIds = new Set(await this.ownedCalendarIds(userId));
    const allOwned = groups.every((group) =>
      ownedCalendarIds.has(group.calendarId),
    );

    if (!allOwned) {
      throw new ForbiddenException('You do not have access to these groups');
    }

    const groupById = new Map(groups.map((group) => [group.id, group]));

    let anyChanged = false;
    const reordered = await Promise.all(
      groupIds.map((groupId, index) => {
        const group = groupById.get(groupId) as TaskGroup;

        if (group.sortOrder === index) return Promise.resolve(group);

        group.sortOrder = index;
        anyChanged = true;

        return this.taskGroupDatabaseService.save(group);
      }),
    );

    if (anyChanged) {
      await this.syncStateService.bump(userId);
    }

    return reordered;
  }

  /**
   * Returns every group across all calendars the user owns, ordered by
   * `sortOrder` ascending. Recurrence is the inline `recurrenceConfig` on each
   * row (no relation to load). Returns an empty array when the user owns no
   * calendars.
   */
  async findAllForUser(userId: string): Promise<TaskGroup[]> {
    const calendarIds = await this.ownedCalendarIds(userId);

    if (calendarIds.length === 0) return [];

    return this.taskGroupDatabaseService.findAll({
      where: { calendarId: In(calendarIds) },
      order: { sortOrder: 'ASC' },
    });
  }

  /**
   * Returns the groups in a single calendar (ownership asserted), ordered by
   * `sortOrder` ascending. Recurrence is the inline `recurrenceConfig` on each row.
   */
  async findAllByCalendar(
    userId: string,
    calendarId: string,
  ): Promise<TaskGroup[]> {
    await this.ensureCalendarOwnedByUser(calendarId, userId);

    return this.taskGroupDatabaseService.findAll({
      where: { calendarId },
      order: { sortOrder: 'ASC' },
    });
  }

  /**
   * Returns every group across the user's calendars whose name matches exactly.
   * Returns all matches (not just the first) so the caller can disambiguate when
   * the same name exists in more than one calendar.
   */
  async findByName(userId: string, name: string): Promise<TaskGroup[]> {
    const calendarIds = await this.ownedCalendarIds(userId);

    if (calendarIds.length === 0) return [];

    return this.taskGroupDatabaseService.findAll({
      where: { calendarId: In(calendarIds), name },
      order: { sortOrder: 'ASC' },
    });
  }

  /**
   * Renames a group after asserting ownership. Short-circuits and returns the
   * group untouched when the name is unchanged.
   */
  @Transactional()
  async rename(
    userId: string,
    groupId: string,
    name: string,
  ): Promise<TaskGroup> {
    const group = await this.findOwnedGroup(userId, groupId);

    if (group.name === name) return group;

    group.name = name;

    const saved = await this.taskGroupDatabaseService.save(group);

    await this.syncStateService.bump(userId);

    return saved;
  }

  /**
   * Deletes a group after asserting ownership. Contained tasks are not deleted;
   * their `groupId` is set null by the FK rule.
   *
   * Order matters: capture the live member ids FIRST, delete the group (the FK
   * `SET NULL` fires), THEN touch those members so any delta observes their
   * post-delete `groupId = null` state (a group that carried a default rule /
   * color just stopped applying it — the members' effective settings changed
   * even though their own rows were not otherwise written). All in one
   * transaction so no delta can see an intermediate state.
   */
  @Transactional()
  async remove(userId: string, groupId: string): Promise<void> {
    const group = await this.findOwnedGroup(userId, groupId);

    const memberIds = await this.taskDatabaseService.findIdsByGroup(group.id);

    await this.taskGroupDatabaseService.delete(group.id);

    await this.taskDatabaseService.touchByIds(memberIds);

    await this.syncStateService.bump(userId);
  }

  /**
   * Applies the recurrence portion of a group update by mutating the inline
   * `recurrenceConfig` on the group row: clears it when `changes.recurrence` is
   * explicitly `null`, sets/replaces it from the DTO otherwise. Returns whether
   * the config actually changed (so the caller knows to `save`). No separate rule
   * lifecycle — the config lives on the row (ADR 0054).
   */
  private applyRecurrenceUpdate(
    group: TaskGroup,
    changes: UpdateTaskGroupInput,
  ): boolean {
    if (changes.recurrence === undefined) return false;

    if (changes.recurrence === null) {
      if (group.recurrenceConfig === null) return false;

      group.recurrenceConfig = null;

      return true;
    }

    group.recurrenceConfig = RecurrenceRuleService.toConfig(changes.recurrence);

    return true;
  }

  /**
   * Loads a group by id and asserts the user owns its calendar.
   * Throws 404 when the group is missing, 403 when it belongs to another user.
   */
  private async findOwnedGroup(
    userId: string,
    groupId: string,
  ): Promise<TaskGroup> {
    const group = await this.taskGroupDatabaseService.findOneBy({
      id: groupId,
    });

    if (!group) {
      throw new EntityNotFoundException(TaskGroup);
    }

    await this.ensureCalendarOwnedByUser(group.calendarId, userId);

    return group;
  }

  /**
   * Returns the ids of every calendar the user owns.
   */
  private async ownedCalendarIds(userId: string): Promise<string[]> {
    const calendars = await this.calendarDatabaseService.findAllByOwner(userId);

    return calendars.map((calendar) => calendar.id);
  }

  /**
   * Loads the calendar and asserts the given user owns it.
   * Throws 404 when missing, 403 when owned by someone else.
   */
  private async ensureCalendarOwnedByUser(
    calendarId: string,
    userId: string,
  ): Promise<void> {
    const calendar = await this.calendarDatabaseService.findOneBy({
      id: calendarId,
    });

    if (!calendar) {
      throw new EntityNotFoundException(Calendar);
    }

    if (calendar.ownerId !== userId) {
      throw new ForbiddenException('You do not have access to this calendar');
    }
  }
}
