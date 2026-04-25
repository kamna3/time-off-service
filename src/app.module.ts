import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { TimeOffModule } from './modules/time-off/time-off.module';
import { BalanceModule } from './modules/balance/balance.module';
import { SyncModule } from './modules/sync/sync.module';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { Balance } from './entities/balance.entity';
import { SyncLog } from './entities/sync-log.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DB_PATH || 'time-off.db',
      entities: [TimeOffRequest, Balance, SyncLog],
      synchronize: true,
    }),
    ScheduleModule.forRoot(),
    TimeOffModule,
    BalanceModule,
    SyncModule,
  ],
})
export class AppModule {}
