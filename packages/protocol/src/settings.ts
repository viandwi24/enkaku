import { z } from 'zod'

/** Baterai & termal per device (spec §15.2). */
export const BatteryStateSchema = z.object({
  level: z.number().min(0).max(100),
  /** dumpsys 'temperature' (deci-°C) / 10. */
  temperatureC: z.number(),
  status: z.enum(['charging', 'discharging', 'not_charging', 'full', 'unknown']),
  health: z.enum(['good', 'overheat', 'dead', 'over_voltage', 'cold', 'unknown']),
  voltageMv: z.number().optional(),
  /** Unix epoch detik. */
  updatedAt: z.number(),
})
export type BatteryState = z.infer<typeof BatteryStateSchema>

/** Timing realism (spec §9.3). */
export const TimingSettingsSchema = z.object({
  tapJitterMs: z
    .tuple([z.number(), z.number()])
    .default([40, 120])
    .describe('Rentang acak durasi tekan (ms)'),
  betweenActionMs: z
    .tuple([z.number(), z.number()])
    .default([300, 900])
    .describe('Rentang acak jeda antar aksi (ms)'),
  coordJitterPx: z.number().default(2).describe('Offset acak koordinat tap (px)'),
})

/** DeviceSettings per device (spec §12). */
export const DeviceSettingsSchema = z.object({
  timing: TimingSettingsSchema.default({ tapJitterMs: [40, 120], betweenActionMs: [300, 900], coordJitterPx: 2 }),
  prep: z
    .object({
      disableAnimations: z.boolean().default(true).describe('Matikan animasi sistem sebelum job'),
      stayAwake: z.boolean().default(true).describe('Layar tetap menyala saat di-charge'),
    })
    .default({ disableAnimations: true, stayAwake: true }),
  input: z
    .object({
      preferredMode: z
        .enum(['uhid', 'sdk', 'aoa'])
        .default('uhid')
        .describe('Mode injeksi input (uhid = hardware-like)'),
    })
    .default({ preferredMode: 'uhid' }),
  autoReconnect: z.boolean().default(true).describe('Sambung ulang otomatis saat device hilang'),
})
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>

/** Setting farm-wide (single row). */
export const FarmSettingsSchema = z.object({
  defaults: z
    .object({
      transport: z.string().default('adb-usb').describe('Transport default device baru'),
      display: z.string().default('screencap-loop').describe('Display default device baru'),
      input: z.string().default('adb-input').describe('Input default device baru'),
      inspection: z.string().default('ui-server').describe('Inspector default device baru'),
      timing: TimingSettingsSchema.default({
        tapJitterMs: [40, 120],
        betweenActionMs: [300, 900],
        coordJitterPx: 2,
      }),
    })
    .default({
      transport: 'adb-usb',
      display: 'screencap-loop',
      input: 'adb-input',
      inspection: 'ui-server',
      timing: { tapJitterMs: [40, 120], betweenActionMs: [300, 900], coordJitterPx: 2 },
    }),
  battery: z
    .object({
      pollIntervalSec: z.number().int().min(10).default(60).describe('Interval poll dumpsys battery (detik)'),
      autoQuarantine: z.boolean().default(true).describe('Quarantine otomatis saat device terlalu panas'),
      tempThresholdC: z.number().default(45).describe('Ambang suhu quarantine (°C)'),
    })
    .default({ pollIntervalSec: 60, autoQuarantine: true, tempThresholdC: 45 }),
  retention: z
    .object({
      enabled: z.boolean().default(false),
      maxAgeDays: z.number().int().default(30),
      maxTotalGb: z.number().default(20),
    })
    .default({ enabled: false, maxAgeDays: 30, maxTotalGb: 20 })
    .describe('Retention artifact — enforcement aktif mulai M7'),
})
export type FarmSettings = z.infer<typeof FarmSettingsSchema>

export const defaultFarmSettings = (): FarmSettings => FarmSettingsSchema.parse({})
export const defaultDeviceSettings = (): DeviceSettings => DeviceSettingsSchema.parse({})
