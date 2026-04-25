import { IsString, IsDateString, IsNumber, IsOptional, IsPositive, Min } from 'class-validator';

export class CreateTimeOffRequestDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsNumber()
  @IsPositive()
  daysRequested: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ApproveRequestDto {
  @IsString()
  managerId: string;
}

export class RejectRequestDto {
  @IsString()
  managerId: string;

  @IsString()
  rejectionReason: string;
}

export class BatchSyncDto {
  balances: Array<{
    employeeId: string;
    locationId: string;
    balance: number;
    version?: string;
  }>;
}
