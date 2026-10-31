import type { WebsiteStored } from './website.schemas.js';

/** turf-admin's defaults (src/services/website-settings.ts), so a fresh install shows a complete portal. */
export const DEFAULT_WEBSITE: WebsiteStored = {
  hero: {
    badge: 'BOOK IN 60 SECONDS',
    headline: 'Welcome to',
    description:
      'Six fields under one roof — football 5×5 / 6×6 / 7×7, full-size cricket nets and indoor badminton courts. Real-time slot availability, instant confirmation.',
    imageUrl: 'https://images.unsplash.com/photo-1551958219-acbc608c6377?w=1920',
  },
  sections: {
    sportChips: { enabled: true, title: 'Browse by sport' },
    featuredGrounds: { enabled: true, title: 'Our grounds', subtitle: 'Pick the field that fits your match' },
    amenities: {
      enabled: true,
      title: 'More than just a pitch',
      subtitle: 'Everything you need at the venue, included with every booking.',
      items: [
        { icon: 'parking', label: 'Free parking' },
        { icon: 'showers', label: 'Showers' },
        { icon: 'lockers', label: 'Locker rooms' },
        { icon: 'cafe', label: 'On-site café' },
        { icon: 'wifi', label: 'Free Wi-Fi' },
        { icon: 'firstAid', label: 'First aid' },
      ],
    },
    howItWorks: {
      enabled: true,
      badge: 'HOW IT WORKS',
      title: 'Three steps to your match',
      steps: [
        { title: 'Pick a ground', body: 'Choose from our 6 grounds — football 5×5 / 6×6 / 7×7 / 11×11, cricket nets or badminton.' },
        { title: 'Pick a slot & pay', body: 'Real-time hourly availability. Pay securely via Stripe — card, Apple Pay, Google Pay.' },
        { title: 'Show up & play', body: 'Confirmation lands in your inbox. Free cancellation up to 24h before kickoff.' },
      ],
      buttonLabel: 'Browse our grounds',
    },
    visitUs: {
      enabled: true,
      badge: 'VISIT US',
      title: 'One venue. Six grounds. Open 18 hours a day.',
      imageUrl: 'https://images.unsplash.com/photo-1486286701208-1d58e9338013?w=1200',
    },
  },
  social: { facebook: '', instagram: '', whatsapp: '' },
};
