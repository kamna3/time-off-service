import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

export enum SyncType {
  REALTIME = 'REALTIME',
  BATCH = 'BATCH',
  WEBHOOK = 'WEBHOOK',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

@Entity('sync_logs')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  syncType: SyncType;

  @Column()
  syncStatus: SyncStatus;

  @Column({ nullable: true })
  employeeId: string;

  @Column({ nullable: true })
  locationId: string;

  @Column('integer', { default: 0 })
  recordsProcessed: number;

  @Column('integer', { default: 0 })
  recordsUpdated: number;

  @Column({ nullable: true, type: 'text' })
  errorDetails: string;

  @Column({ nullable: true, type: 'text' })
  metadata: string; // JSON blob

  @CreateDateColumn()
  createdAt: Date;
}
