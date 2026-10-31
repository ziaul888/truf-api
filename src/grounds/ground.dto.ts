import type { AvailableDays, Ground, Sport, Weekday } from '../generated/prisma/client.js';
import type { PeakRange } from './ground-schedule.js';
import { photoUrl } from './photo-storage.js';

/** What customers see. Only active grounds shown on the portal are ever returned publicly. */
export interface PublicGroundDto {
  id: string;
  name: string;
  description: string | null;
  address: string | null;
  mapUrl: string | null;
  hourlyPrice: number;
  peakPrice: number | null;
  peakRanges: PeakRange[];
  openingHour: number;
  closingHour: number;
  slotDurationMinutes: number;
  sport: Sport;
  format: string | null;
  surface: string | null;
  dimensions: string | null;
  capacity: number | null;
  amenities: string[];
  availableDays: AvailableDays;
  customDays: Weekday[];
  /** URLs in display order; the first is the cover. */
  photos: string[];
}

/** What the dashboard sees: adds staff-only fields such as `internalNotes`. */
export interface GroundDto extends PublicGroundDto {
  isActive: boolean;
  showOnPortal: boolean;
  internalNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** peakRanges is a JSON column; the API validates it on every write, so the cast is safe. */
export const peakRangesOf = (g: Ground) => g.peakRanges as unknown as PeakRange[];

export const toPublicGroundDto = (g: Ground): PublicGroundDto => ({
  id: g.id,
  name: g.name,
  description: g.description,
  address: g.address,
  mapUrl: g.mapUrl,
  hourlyPrice: g.hourlyPrice,
  peakPrice: g.peakPrice,
  peakRanges: peakRangesOf(g),
  openingHour: g.openingHour,
  closingHour: g.closingHour,
  slotDurationMinutes: g.slotDurationMinutes,
  sport: g.sport,
  format: g.format,
  surface: g.surface,
  dimensions: g.dimensions,
  capacity: g.capacity,
  amenities: g.amenities,
  availableDays: g.availableDays,
  customDays: g.customDays,
  photos: g.photos.map((name) => photoUrl(g.id, name)),
});

export const toGroundDto = (g: Ground): GroundDto => ({
  ...toPublicGroundDto(g),
  isActive: g.isActive,
  showOnPortal: g.showOnPortal,
  internalNotes: g.internalNotes,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
});
