import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, Index, Unique,
} from 'typeorm';

@Entity('balances')
@Unique(['employeeId', 'locationId'])
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  employeeId: string;

  @Column()
  locationId: string;

  /** Total balance as known from HCM (source of truth) */
  @Column('float', { default: 0 })
  hcmBalance: number;

  /** Locally computed available balance after pending requests */
  @Column('float', { default: 0 })
  availableBalance: number;

  /** Days consumed by APPROVED requests confirmed by HCM */
  @Column('float', { default: 0 })
  usedBalance: number;

  /** Days reserved by PENDING requests (optimistic lock) */
  @Column('float', { default: 0 })
  reservedBalance: number;

  /** Timestamp of last successful sync from HCM */
  @Column({ nullable: true })
  lastSyncedAt: Date;

  /** ETag / version from HCM to detect stale data */
  @Column({ nullable: true })
  hcmVersion: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
