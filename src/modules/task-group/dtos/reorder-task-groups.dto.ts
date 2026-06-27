import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * DTO for the bulk-reorder endpoint. `groupIds` is the complete, ordered list of
 * group ids whose position changed; the server assigns `sortOrder` from the array
 * index transactionally, replacing the racy N single-PATCH approach. Every id must
 * belong to a calendar the current user owns or the whole request is rejected.
 */
export class ReorderTaskGroupsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Ordered group ids; each row receives a sortOrder equal to its index.',
    example: [
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      '5c1d8f0e-1a2b-4c3d-9e8f-7a6b5c4d3e2f',
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  groupIds: string[];
}
