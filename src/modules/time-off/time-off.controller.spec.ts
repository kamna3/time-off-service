import { Test, TestingModule } from '@nestjs/testing';
import { TimeOffController } from '../../modules/time-off/time-off.controller';
import { TimeOffService } from '../../modules/time-off/time-off.service';
import { RequestStatus } from '../../entities/time-off-request.entity';

const mockTimeOffService = () => ({
  createRequest: jest.fn(),
  listRequests: jest.fn(),
  getRequest: jest.fn(),
  approveRequest: jest.fn(),
  rejectRequest: jest.fn(),
  cancelRequest: jest.fn(),
});

describe('TimeOffController', () => {
  let controller: TimeOffController;
  let service: ReturnType<typeof mockTimeOffService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TimeOffController],
      providers: [{ provide: TimeOffService, useFactory: mockTimeOffService }],
    }).compile();

    controller = module.get<TimeOffController>(TimeOffController);
    service = module.get(TimeOffService);
  });

  it('should call createRequest with correct DTO', async () => {
    const dto = {
      employeeId: 'emp-001', locationId: 'loc-us',
      startDate: '2025-06-01', endDate: '2025-06-03', daysRequested: 3,
    };
    service.createRequest.mockResolvedValue({ id: 'req-001', ...dto, status: RequestStatus.PENDING });

    const result = await controller.create(dto);
    expect(service.createRequest).toHaveBeenCalledWith(dto);
    expect(result.status).toBe(RequestStatus.PENDING);
  });

  it('should call listRequests with query params', async () => {
    service.listRequests.mockResolvedValue([]);
    await controller.list('emp-001', RequestStatus.PENDING);
    expect(service.listRequests).toHaveBeenCalledWith('emp-001', RequestStatus.PENDING);
  });

  it('should call getRequest with id', async () => {
    service.getRequest.mockResolvedValue({ id: 'req-001' });
    await controller.get('req-001');
    expect(service.getRequest).toHaveBeenCalledWith('req-001');
  });

  it('should call approveRequest with id and DTO', async () => {
    service.approveRequest.mockResolvedValue({ status: RequestStatus.APPROVED });
    await controller.approve('req-001', { managerId: 'mgr-001' });
    expect(service.approveRequest).toHaveBeenCalledWith('req-001', { managerId: 'mgr-001' });
  });

  it('should call rejectRequest with id and DTO', async () => {
    service.rejectRequest.mockResolvedValue({ status: RequestStatus.REJECTED });
    await controller.reject('req-001', { managerId: 'mgr-001', rejectionReason: 'No cover' });
    expect(service.rejectRequest).toHaveBeenCalledWith('req-001', { managerId: 'mgr-001', rejectionReason: 'No cover' });
  });

  it('should call cancelRequest with id', async () => {
    service.cancelRequest.mockResolvedValue({ status: RequestStatus.CANCELLED });
    await controller.cancel('req-001');
    expect(service.cancelRequest).toHaveBeenCalledWith('req-001');
  });
});
