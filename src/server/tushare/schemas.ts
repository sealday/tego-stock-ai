import { z } from 'zod';

const dailyRowSchema = z
  .object({
    ts_code: z.string(),
    trade_date: z.string(),
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    vol: z.number().finite().nonnegative(),
    amount: z.number().finite().nonnegative(),
    adj_factor: z.number().finite().positive().nullable().optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.high < Math.max(row.open, row.close, row.low)) {
      context.addIssue({
        code: 'custom',
        path: ['high'],
        message: 'High price must contain the OHLC range',
      });
    }
    if (row.low > Math.min(row.open, row.close, row.high)) {
      context.addIssue({
        code: 'custom',
        path: ['low'],
        message: 'Low price must contain the OHLC range',
      });
    }
  });

const dailyRowsSchema = z.array(dailyRowSchema);

const stockRowSchema = z
  .object({
    ts_code: z.string(),
    name: z.string().min(1),
    cnspell: z.string().min(1),
    list_status: z.enum(['L', 'D', 'P']),
  })
  .strict();

const fundamentalRowSchema = z
  .object({
    ts_code: z.string(),
    ann_date: z.string(),
    end_date: z.string(),
    roe: z.number().finite().nullable(),
    grossprofit_margin: z.number().finite().nullable(),
    or_yoy: z.number().finite().nullable(),
    netprofit_yoy: z.number().finite().nullable(),
    ocf_to_opincome: z.number().finite().nullable().optional(),
    debt_to_assets: z.number().finite().nullable(),
    update_flag: z.enum(['0', '1']).optional(),
  })
  .strict();

const incomeStatementRowSchema = z
  .object({
    ts_code: z.string(),
    ann_date: z.string(),
    end_date: z.string(),
    report_type: z.string(),
    n_income_attr_p: z.number().finite().nullable(),
    update_flag: z.enum(['0', '1']).optional(),
  })
  .strict();

const cashflowStatementRowSchema = z
  .object({
    ts_code: z.string(),
    ann_date: z.string(),
    end_date: z.string(),
    report_type: z.string(),
    n_cashflow_act: z.number().finite().nullable(),
    update_flag: z.enum(['0', '1']).optional(),
  })
  .strict();

const overviewSchema = z.object({
  daily: z.array(
    z
      .object({
        ts_code: z.string(),
        trade_date: z.string(),
        close: z.number().finite(),
        pre_close: z.number().finite().nullable(),
        pct_chg: z.number().finite().nullable(),
      })
      .strict(),
  ),
  stocks: z.array(z.object({ ts_code: z.string(), name: z.string().min(1) }).strict()),
  valuation: z.array(
    z
      .object({
        ts_code: z.string(),
        trade_date: z.string(),
        pe_ttm: z.number().finite().nullable(),
        pb: z.number().finite().nullable(),
        total_mv: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
  ),
});

const providerTableSchema = z.object({
  fields: z.array(z.string()),
  items: z.array(z.array(z.unknown())),
});

const providerResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().nullable().optional(),
  data: providerTableSchema.nullable().optional(),
});

export function parseDailyRows(value: unknown) {
  return dailyRowsSchema.parse(value);
}

export function parseStockRows(value: unknown) {
  return z.array(stockRowSchema).parse(value);
}

export function parseFundamentalRows(value: unknown) {
  return z.array(fundamentalRowSchema).parse(value);
}

export function parseIncomeStatementRows(value: unknown) {
  return z.array(incomeStatementRowSchema).parse(value);
}

export function parseCashflowStatementRows(value: unknown) {
  return z.array(cashflowStatementRowSchema).parse(value);
}

export function parseOverviewRows(value: unknown) {
  return overviewSchema.parse(value);
}

export function parseProviderResponse(value: unknown) {
  return providerResponseSchema.parse(value);
}
