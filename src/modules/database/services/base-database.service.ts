import { PaginateConfig, PaginateQuery } from 'nestjs-paginate';
import {
  DeepPartial,
  DeleteResult,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
} from 'typeorm';

import { BaseEntity } from '../entities';
import { BaseRepository } from '../repositories';

import { EntityNotFoundException } from '@/exceptions/entity-not-found.exception';

/**
 * Abstract base service providing common CRUD and pagination helpers
 * on top of a BaseRepository. All feature services consume entities via subclasses of this service.
 */
export abstract class BaseDatabaseService<TEntity extends BaseEntity> {
  constructor(private repository: BaseRepository<TEntity>) {}

  /**
   * Creates a new entity instance and persists it, returning the saved row.
   */
  async create(entity?: DeepPartial<TEntity>): Promise<TEntity> {
    const newInstance = entity
      ? this.repository.create(entity)
      : this.repository.create();
    const savedEntity = await this.repository.save(newInstance);

    return savedEntity;
  }

  /**
   * Builds an in-memory entity instance without persisting it. Useful for
   * pre-populating defaults before further mutation.
   */
  createInstance(entity?: DeepPartial<TEntity>): TEntity {
    const newInstance = entity
      ? this.repository.create(entity)
      : this.repository.create();

    return newInstance;
  }

  /**
   * Persists an entity instance that has already been created or mutated in memory.
   */
  save(entity: TEntity): Promise<TEntity> {
    return this.repository.save(entity);
  }

  /**
   * Finds a single entity by the given TypeORM find options.
   * Returns null when no row matches.
   */
  findOne(options: FindOneOptions<TEntity>): Promise<TEntity | null> {
    return this.repository.findOne(options);
  }

  /**
   * Finds a single entity by a plain `where` object. Returns null when no row matches.
   */
  findOneBy(options: FindOptionsWhere<TEntity>): Promise<TEntity | null> {
    return this.repository.findOneBy(options);
  }

  /**
   * Retrieves all entities matching the given find options (defaulting to everything).
   */
  findAll(options?: FindManyOptions<TEntity>): Promise<TEntity[]> {
    return this.repository.find(options);
  }

  /**
   * Retrieves all entities matching a plain `where` object.
   */
  findAllBy(where: FindOptionsWhere<TEntity>): Promise<TEntity[]> {
    return this.repository.findBy(where);
  }

  /**
   * Finds a single entity by options or throws EntityNotFoundException if none exists.
   */
  async findOneOrThrow(options: FindOneOptions<TEntity>): Promise<TEntity> {
    const entity = await this.findOne(options);

    if (!entity) {
      throw new EntityNotFoundException(this.repository.target);
    }

    return entity;
  }

  /**
   * Finds a single entity by `where` clause or throws EntityNotFoundException if none exists.
   */
  findOneByOrThrow(where: FindOptionsWhere<TEntity>): Promise<TEntity> {
    return this.findOneOrThrow({ where });
  }

  /**
   * Merges the provided partial into an existing entity and saves it.
   */
  update(entity: TEntity, updateData: DeepPartial<TEntity>): Promise<TEntity> {
    const updatedEntity = this.repository.merge(entity, updateData);

    return this.repository.save(updatedEntity);
  }

  /**
   * Updates a row by id using a partial payload. Returns the persisted entity.
   */
  async updateById(id: string, updateData: DeepPartial<Omit<TEntity, 'id'>>) {
    const entity = this.repository.create({
      id,
      ...updateData,
    } as DeepPartial<TEntity>);

    return this.repository.save(entity);
  }

  /**
   * Updates an entity, throwing EntityNotFoundException if the update produced no result.
   */
  async updateOrThrow(
    entity: TEntity,
    updateData: DeepPartial<TEntity>,
  ): Promise<TEntity> {
    const updated = await this.update(entity, updateData);

    if (!updated) {
      throw new EntityNotFoundException(this.repository.target);
    }

    return updated;
  }

  /**
   * Deletes one or more entities identified by id(s) or a `where` clause.
   */
  delete(
    id:
      | string
      | string[]
      | FindOptionsWhere<TEntity>
      | FindOptionsWhere<TEntity>[],
  ): Promise<DeleteResult> {
    return this.repository.delete(id);
  }

  /**
   * Deletes by id, throwing EntityNotFoundException if nothing was affected.
   */
  async deleteOrThrow(id: string): Promise<DeleteResult> {
    const result = await this.repository.delete(id);

    if (!result.affected) {
      throw new EntityNotFoundException(this.repository.target);
    }

    return result;
  }

  /**
   * Delegates to the repository's nestjs-paginate helper for paginated listings.
   */
  getPaginated(
    query: PaginateQuery,
    config?: Partial<PaginateConfig<TEntity>>,
  ) {
    return this.repository.getPaginated(query, config);
  }

  /**
   * Increments a numeric property of matching rows by the given value.
   */
  increment(
    where: FindOptionsWhere<TEntity>,
    propertyPath: string,
    value: number,
  ) {
    return this.repository.increment(where, propertyPath, value);
  }

  /**
   * Decrements a numeric property of matching rows by the given value.
   */
  decrement(
    where: FindOptionsWhere<TEntity>,
    propertyPath: string,
    value: number,
  ) {
    return this.repository.decrement(where, propertyPath, value);
  }
}
