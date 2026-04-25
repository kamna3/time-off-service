import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  balance: number;
  version?: string;
}

export interface HcmDeductionResult {
  success: boolean;
  transactionId?: string;
  remainingBalance?: number;
  error?: string;
  errorCode?: string;
}

@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.HCM_BASE_URL || 'http://localhost:4000',
      timeout: parseInt(process.env.HCM_TIMEOUT_MS || '5000'),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.HCM_API_KEY || 'mock-api-key',
      },
    });
  }

  /**
   * Realtime: Get balance for a single employee/location combination.
   */
  async getBalance(employeeId: string, locationId: string): Promise<HcmBalance | null> {
    try {
      const { data } = await this.client.get(
        `/balances/${employeeId}/${locationId}`,
      );
      return data;
    } catch (err) {
      this.logger.warn(
        `HCM getBalance failed for ${employeeId}/${locationId}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Realtime: Deduct days from HCM balance when a request is approved.
   * Returns the transaction result for idempotency tracking.
   */
  async deductBalance(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmDeductionResult> {
    try {
      const { data } = await this.client.post('/balances/deduct', {
        employeeId,
        locationId,
        days,
        idempotencyKey,
      });
      return { success: true, ...data };
    } catch (err) {
      const errorData = err.response?.data || {};
      this.logger.error(
        `HCM deductBalance failed for ${employeeId}: ${err.message}`,
      );
      return {
        success: false,
        error: errorData.message || err.message,
        errorCode: errorData.code || 'UNKNOWN_ERROR',
      };
    }
  }

  /**
   * Batch endpoint: Fetch ALL employee balances.
   * Used for full reconciliation syncs.
   */
  async batchFetchAllBalances(): Promise<HcmBalance[]> {
    try {
      const { data } = await this.client.get('/balances/batch');
      return data.balances || [];
    } catch (err) {
      this.logger.error(`HCM batch fetch failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Realtime: Restore (credit back) days to HCM when a request is cancelled
   * after it was already approved and HCM-confirmed.
   */
  async creditBalance(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmDeductionResult> {
    try {
      const { data } = await this.client.post('/balances/credit', {
        employeeId,
        locationId,
        days,
        idempotencyKey,
      });
      return { success: true, ...data };
    } catch (err) {
      const errorData = err.response?.data || {};
      this.logger.error(
        `HCM creditBalance failed for ${employeeId}: ${err.message}`,
      );
      return {
        success: false,
        error: errorData.message || err.message,
        errorCode: errorData.code || 'UNKNOWN_ERROR',
      };
    }
  }
}
