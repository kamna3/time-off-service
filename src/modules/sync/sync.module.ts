import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLog } from '../../entities/sync-log.entity';
import { TimeOffRequest } from '../../entities/time-off-request.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { HcmClientService } from './hcm-client.service';
import { BalanceModule } from '../balance/balance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLog, TimeOffRequest]),
    BalanceModule,
  ],
  providers: [SyncService, HcmClientService],
  controllers: [SyncController],
  exports: [SyncService, HcmClientService],
})
export class SyncModule {}
