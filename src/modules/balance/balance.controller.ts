import { Controller, Get, Param, Query } from '@nestjs/common';
import { BalanceService } from './balance.service';

@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get()
  listBalances(@Query('employeeId') employeeId?: string) {
    return this.balanceService.listBalances(employeeId);
  }

  @Get(':employeeId/:locationId')
  getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.balanceService.getBalance(employeeId, locationId);
  }
}
