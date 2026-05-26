import { IsBoolean } from 'class-validator';

/**
 * DTO for toggling a Task's completion state.
 * `true` marks the task complete (stamps `completedAt` with `now` if unset),
 * `false` clears `completedAt`.
 */
export class SetTaskCompletedDto {
  @IsBoolean()
  isCompleted: boolean;
}
