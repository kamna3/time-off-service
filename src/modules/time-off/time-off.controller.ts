import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query,
} from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import {
  CreateTimeOffRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
} from '../../dtos/time-off.dto';
import { RequestStatus } from '../../entities/time-off-request.entity';

@Controller('time-off')
export class TimeOffController {
  constructor(private readonly timeOffService: TimeOffService) {}

  /** POST /api/v1/time-off — Submit a new time-off request */
  @Post()
  create(@Body() dto: CreateTimeOffRequestDto) {
    return this.timeOffService.createRequest(dto);
  }

  /** GET /api/v1/time-off — List all requests (filterable) */
  @Get()
  list(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: RequestStatus,
  ) {
    return this.timeOffService.listRequests(employeeId, status);
  }

  /** GET /api/v1/time-off/:id — Get a single request */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.timeOffService.getRequest(id);
  }

  /** PATCH /api/v1/time-off/:id/approve — Manager approves */
  @Patch(':id/approve')
  approve(@Param('id') id: string, @Body() dto: ApproveRequestDto) {
    return this.timeOffService.approveRequest(id, dto);
  }

  /** PATCH /api/v1/time-off/:id/reject — Manager rejects */
  @Patch(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectRequestDto) {
    return this.timeOffService.rejectRequest(id, dto);
  }

  /** DELETE /api/v1/time-off/:id — Employee cancels */
  @Delete(':id')
  cancel(@Param('id') id: string) {
    return this.timeOffService.cancelRequest(id);
  }
}
