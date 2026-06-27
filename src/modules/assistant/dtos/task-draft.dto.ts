import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CreateRecurrenceRuleDto } from '@/modules/recurrence-rule/dtos';

/**
 * Response DTO for `POST /assistant/parse` (D4) — the structured task draft the
 * assistant extracted from one line of natural language. It is a DRAFT only: no
 * task is created. The iOS quick-create well pre-fills its fields from this and
 * lets the user confirm/edit before a real `POST /tasks`.
 *
 * `start` is an ISO-8601 datetime resolved in the user's timezone (omitted for a
 * timeless todo). `durationMinutes` is present only when the text implied a
 * length. `recurrence` mirrors the RFC-5545-lite rule grammar (omitted for a
 * one-off). `groupId` is the id of an EXISTING group the draft was matched to
 * (omitted when none applied) — never a freshly-created group.
 */
export class TaskDraftDTO {
  @ApiProperty({
    description: 'Extracted task title, with scheduling words stripped.',
    example: 'gym',
  })
  title: string;

  @ApiPropertyOptional({
    description:
      'ISO-8601 start datetime resolved in the user timezone, or omitted for a timeless todo.',
    format: 'date-time',
    example: '2026-06-29T07:00:00.000+02:00',
  })
  start?: string;

  @ApiPropertyOptional({
    description:
      'Duration in minutes, present only when the text implied a length.',
    example: 60,
    minimum: 1,
  })
  durationMinutes?: number;

  @ApiPropertyOptional({
    description: 'Recurrence rule, present only when the text stated a repeat.',
    type: CreateRecurrenceRuleDto,
  })
  recurrence?: CreateRecurrenceRuleDto;

  @ApiPropertyOptional({
    description:
      'Id of an existing group the draft was matched to, omitted when none applied.',
    format: 'uuid',
  })
  groupId?: string;
}
