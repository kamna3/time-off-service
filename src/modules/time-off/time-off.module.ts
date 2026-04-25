import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from '../../entities/time-off-request.entity';
import { TimeOffService } from './time-off.service';
import { TimeOffController } from './time-off.controller';
import { BalanceModule } from '../balance/balance.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [TypeOrmModule.forFeature([TimeOffRequest]), BalanceModule, SyncModule],
  providers: [TimeOffService],
  controllers: [TimeOffController],
  exports: [TimeOffService],
})
export class TimeOffModule {}
