import { ForbiddenException, Injectable } from '@nestjs/common';
import { In } from 'typeorm';

import { CreateTaskGroupDto } from './dtos';
import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';
import { Calendar, TaskGroup } from '@/modules/database/entities';
import {
  CalendarDatabaseService,
  TaskGroupDatabaseService,
} from '@/modules/database/services';
import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';
import { RecurrenceRuleService } from '@/modules/recurrence-rule/recurrence-rule.service';

/**
 * Fields the REST layer may change on an existing task group.
 * `recurrence` set to a DTO adds or replaces the group's default rule;
 * set to `null` removes it. All keys are optional.
 */
export interface UpdateTaskGroupInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
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
    private readonly recurrenceRuleService: RecurrenceRuleService,
  ) {}

  /**
   * Creates a TaskGroup inside the calendar named by `dto.calendarId` after
   * asserting the calendar belongs to the user. When `dto.recurrence` is provided,
   * a `RecurrenceRule` is created and linked as the group default. Built via
   * `createInstance` and persisted with `.save()`. Returns the group with its
   * `defaultRecurrenceRule` relation loaded.
   */
  async create(userId: string, dto: CreateTaskGroupDto): Promise<TaskGroup> {
    await this.ensureCalendarOwnedByUser(dto.calendarId, userId);

    const defaultRecurrenceRuleId = dto.recurrence
      ? (await this.recurrenceRuleService.create(dto.recurrence)).id
      : null;

    const group = this.taskGroupDatabaseService.createInstance({
      calendarId: dto.calendarId,
      name: dto.name,
      color: dto.color ?? null,
      icon: dto.icon ?? null,
      defaultNotificationStrategyId: dto.defaultNotificationStrategyId ?? null,
      defaultRecurrenceRuleId,
      sortOrder: dto.sortOrder ?? 0,
    });

    const saved = await this.taskGroupDatabaseService.save(group);

    return this.findOwnedGroupWithRule(userId, saved.id);
  }

  /**
   * Updates a TaskGroup's mutable fields (name, color, icon, sortOrder) and its
   * default recurrence rule. When `changes.recurrence` is a DTO, the existing
   * rule is updated in place (or a new one created); when `null`, the rule is
   * removed; when `undefined`, the rule is left unchanged. Short-circuits when
   * nothing changed. Returns the group with its `defaultRecurrenceRule` relation
   * loaded.
   */
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

    const recurrenceChanged = await this.applyRecurrenceUpdate(group, changes);

    const hasFieldChanges =
      nextName !== group.name ||
      nextColor !== group.color ||
      nextIcon !== group.icon ||
      nextSortOrder !== group.sortOrder;

    if (hasFieldChanges) {
      group.name = nextName;
      group.color = nextColor;
      group.icon = nextIcon;
      group.sortOrder = nextSortOrder;
    }

    if (hasFieldChanges || recurrenceChanged) {
      await this.taskGroupDatabaseService.save(group);
    }

    return this.findOwnedGroupWithRule(userId, groupId);
  }

  /**
   * Returns every group across all calendars the user owns, ordered by
   * `sortOrder` ascending, with `defaultRecurrenceRule` loaded. Returns an empty
   * array when the user owns no calendars.
   */
  async findAllForUser(userId: string): Promise<TaskGroup[]> {
    const calendarIds = await this.ownedCalendarIds(userId);

    if (calendarIds.length === 0) return [];

    return this.taskGroupDatabaseService.findAll({
      where: { calendarId: In(calendarIds) },
      order: { sortOrder: 'ASC' },
      relations: { defaultRecurrenceRule: true },
    });
  }

  /**
   * Returns the groups in a single calendar (ownership asserted), ordered by
   * `sortOrder` ascending, with `defaultRecurrenceRule` loaded.
   */
  async findAllByCalendar(
    userId: string,
    calendarId: string,
  ): Promise<TaskGroup[]> {
    await this.ensureCalendarOwnedByUser(calendarId, userId);

    return this.taskGroupDatabaseService.findAll({
      where: { calendarId },
      order: { sortOrder: 'ASC' },
      relations: { defaultRecurrenceRule: true },
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
  async rename(
    userId: string,
    groupId: string,
    name: string,
  ): Promise<TaskGroup> {
    const group = await this.findOwnedGroup(userId, groupId);

    if (group.name === name) return group;

    group.name = name;

    return this.taskGroupDatabaseService.save(group);
  }

  /**
   * Deletes a group after asserting ownership. Contained tasks are not deleted;
   * their `groupId` is set null by the FK rule.
   */
  async remove(userId: string, groupId: string): Promise<void> {
    const group = await this.findOwnedGroup(userId, groupId);

    await this.taskGroupDatabaseService.delete(group.id);
  }

  /**
   * Applies the recurrence portion of a group update: removes the rule when
   * `changes.recurrence` is explicitly `null`, updates it in place when one
   * already exists, or creates and links a fresh rule otherwise. Returns whether
   * the group's `defaultRecurrenceRuleId` link changed (a rule field-only update
   * does not change the FK).
   */
  private async applyRecurrenceUpdate(
    group: TaskGroup,
    changes: UpdateTaskGroupInput,
  ): Promise<boolean> {
    if (changes.recurrence === undefined) return false;

    if (changes.recurrence === null) {
      if (group.defaultRecurrenceRuleId === null) return false;

      const oldRuleId = group.defaultRecurrenceRuleId;

      group.defaultRecurrenceRuleId = null;
      await this.recurrenceRuleService.remove(oldRuleId);

      return true;
    }

    if (group.defaultRecurrenceRuleId !== null) {
      await this.recurrenceRuleService.update(
        group.defaultRecurrenceRuleId,
        changes.recurrence,
      );

      return false;
    }

    const rule = await this.recurrenceRuleService.create(changes.recurrence);

    group.defaultRecurrenceRuleId = rule.id;

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
   * Loads a group by id WITH its `defaultRecurrenceRule` relation and asserts
   * ownership. Used after writes to return the fully-populated DTO.
   */
  private async findOwnedGroupWithRule(
    userId: string,
    groupId: string,
  ): Promise<TaskGroup> {
    const group = await this.taskGroupDatabaseService.findOne({
      where: { id: groupId },
      relations: { defaultRecurrenceRule: true },
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
