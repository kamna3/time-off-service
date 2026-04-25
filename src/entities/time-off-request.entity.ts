import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, Index,
} from 'typeorm';

export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity('time_off_requests')
@Index(['employeeId', 'locationId'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column()
  startDate: string; // ISO date string YYYY-MM-DD

  @Column()
  endDate: string;

  @Column('float')
  daysRequested: number;

  @Column({ default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ nullable: true })
  managerId: string;

  @Column({ nullable: true })
  approvedAt: Date;

  @Column({ nullable: true })
  rejectionReason: string;

  /** HCM transaction ID for idempotency tracking */
  @Column({ nullable: true })
  hcmTransactionId: string;

  /** Whether HCM has confirmed this deduction */
  @Column({ default: false })
  hcmConfirmed: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
