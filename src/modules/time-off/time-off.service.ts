import {
  Injectable, Logger, BadRequestException,
  NotFoundException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequest, RequestStatus } from '../../entities/time-off-request.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../sync/hcm-client.service';
import {
  CreateTimeOffRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
} from '../../dtos/time-off.dto';


@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  /**
   * Step 1: Create a PENDING time-off request.
   * We do a local balance pre-check (defensive) before persisting.
   * The balance is reserved (optimistic) immediately.
   */
  async createRequest(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    // Validate date range
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    // Defensive local balance check
    const { sufficient, available } = await this.balanceService.hasSufficientBalance(
      dto.employeeId,
      dto.locationId,
      dto.daysRequested,
    );
    if (!sufficient) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${available}, Requested: ${dto.daysRequested}`,
      );
    }

    // Persist as PENDING — this reserves the balance
    const request = this.requestRepo.create({
      ...dto,
      status: RequestStatus.PENDING,
    });
    const saved = await this.requestRepo.save(request);

    // Recompute available balance to reflect the reservation
    await this.balanceService.recomputeAvailableBalance(
      dto.employeeId,
      dto.locationId,
    );

    return saved;
  }

  /**
   * Step 2: Manager approves a request.
   * We attempt to deduct from HCM. If HCM rejects (e.g. insufficient balance
   * there), we mark as REJECTED to keep systems in sync.
   * If HCM is unreachable, we approve locally and flag for reconciliation.
   */
  async approveRequest(
    requestId: string,
    dto: ApproveRequestDto,
  ): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException(
        `Request ${requestId} is already ${request.status}`,
      );
    }

    // Attempt HCM deduction (idempotent via request ID as key)
    const idempotencyKey = `approve-${requestId}`;
    const hcmResult = await this.hcmClient.deductBalance(
      request.employeeId,
      request.locationId,
      request.daysRequested,
      idempotencyKey,
    );

    if (!hcmResult.success) {
      // HCM explicitly rejected (e.g. insufficient balance on their side)
      if (hcmResult.errorCode === 'INSUFFICIENT_BALANCE') {
        this.logger.warn(
          `HCM rejected deduction for ${requestId}: ${hcmResult.error}`,
        );
        // Auto-reject the request since HCM has less balance than we thought
        request.status = RequestStatus.REJECTED;
        request.rejectionReason = `HCM rejected: ${hcmResult.error}`;
        const saved = await this.requestRepo.save(request);
        await this.balanceService.recomputeAvailableBalance(
          request.employeeId, request.locationId,
        );
        // Trigger a re-sync to fix our stale local balance
        this.hcmClient.getBalance(request.employeeId, request.locationId)
          .then(async (freshBalance) => {
            if (freshBalance) {
              await this.balanceService.updateFromHcm(
                request.employeeId,
                request.locationId,
                freshBalance.balance,
                freshBalance.version,
              );
            }
          });
        return saved;
      }

      // HCM is down or returned unknown error — approve locally, flag for reconciliation
      this.logger.warn(
        `HCM unavailable for ${requestId}, approving locally for reconciliation`,
      );
      request.status = RequestStatus.APPROVED;
      request.managerId = dto.managerId;
      request.approvedAt = new Date();
      request.hcmConfirmed = false; // Will be reconciled by sync job
    } else {
      // HCM confirmed — mark fully approved
      request.status = RequestStatus.APPROVED;
      request.managerId = dto.managerId;
      request.approvedAt = new Date();
      request.hcmConfirmed = true;
      request.hcmTransactionId = hcmResult.transactionId;
    }

    const saved = await this.requestRepo.save(request);
    await this.balanceService.recomputeAvailableBalance(
      request.employeeId, request.locationId,
    );
    return saved;
  }

  /**
   * Manager rejects a pending request.
   * Releases the reserved balance back.
   */
  async rejectRequest(
    requestId: string,
    dto: RejectRequestDto,
  ): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException(
        `Request ${requestId} is already ${request.status}`,
      );
    }

    request.status = RequestStatus.REJECTED;
    request.managerId = dto.managerId;
    request.rejectionReason = dto.rejectionReason;

    const saved = await this.requestRepo.save(request);
    await this.balanceService.recomputeAvailableBalance(
      request.employeeId, request.locationId,
    );
    return saved;
  }

  /**
   * Employee cancels a request.
   * If it was APPROVED + HCM-confirmed, we credit back to HCM.
   * If PENDING, we just release the reservation.
   */
  async cancelRequest(requestId: string): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(requestId);

    if (
      request.status === RequestStatus.REJECTED ||
      request.status === RequestStatus.CANCELLED
    ) {
      throw new ConflictException(
        `Request ${requestId} cannot be cancelled (status: ${request.status})`,
      );
    }

    // If already approved and HCM confirmed, we need to credit back
    if (request.status === RequestStatus.APPROVED && request.hcmConfirmed) {
      const idempotencyKey = `cancel-${requestId}`;
      const creditResult = await this.hcmClient.creditBalance(
        request.employeeId,
        request.locationId,
        request.daysRequested,
        idempotencyKey,
      );

      if (!creditResult.success) {
        this.logger.warn(
          `HCM credit failed for cancellation of ${requestId}: ${creditResult.error}`,
        );
        // Still cancel locally — sync job will reconcile with HCM
      }
    }

    request.status = RequestStatus.CANCELLED;
    const saved = await this.requestRepo.save(request);
    await this.balanceService.recomputeAvailableBalance(
      request.employeeId, request.locationId,
    );
    return saved;
  }

  async getRequest(requestId: string): Promise<TimeOffRequest> {
    return this.findOrThrow(requestId);
  }

  async listRequests(
    employeeId?: string,
    status?: RequestStatus,
  ): Promise<TimeOffRequest[]> {
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    return this.requestRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  private async findOrThrow(requestId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException(`Time-off request ${requestId} not found`);
    }
    return request;
  }
}
