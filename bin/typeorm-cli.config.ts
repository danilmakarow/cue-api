import { ConfigService } from '@nestjs/config';

import { getConfigModule } from '../src/config/env.config';
import { getDatabaseConfig, getDataSource } from '../src/config/typeorm.config';

getConfigModule();

export const databaseConfig = getDatabaseConfig(new ConfigService());

export const dataSource = getDataSource(databaseConfig);
