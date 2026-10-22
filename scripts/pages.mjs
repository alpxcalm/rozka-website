/*
 * Page-level text and settings for rozka.work: title, description and breadcrumb label for each page (English).
 * The Hindi and Marathi versions of these strings come from i18n/hi.json and i18n/mr.json, keyed by the English text.
 */
export const PAGES = {
  home: {
    path: '/',
    title: 'Rozka · Attendance & payroll software that runs itself',
    description: "Rozka records every punch at your door, works out each day's pay by your rules and locks every payout with proof. Book a 1-month demo on your own staff.",
    ogTitle: 'Rozka · Attendance in. Salaries out. No register in between.',
    ogDescription: 'Face, fingerprint, card or QR punching, daily pay from your own rules, advances recovered as EMI, and locked payslips. Try it on your real staff for a month.',
    ldType: 'WebPage',
  },
  automation: {
    path: '/automation/',
    title: 'Business automation, built to order · Rozka',
    description: "If it happens every day, it shouldn't need you every day. Rozka builds your repeated work into rules that run on their own, from job cards to stock reminders.",
    ldType: 'WebPage',
    crumb: 'Automation',
  },
  pricing: {
    path: '/pricing/',
    title: 'Pricing from ₹119 per employee per month · Rozka',
    description: 'Prices start at ₹119 per employee per month, inclusive of all taxes, and may vary with your business needs. No setup cost. Contact us for customised pricing.',
    ldType: 'WebPage',
    crumb: 'Pricing',
  },
  about: {
    path: '/about/',
    title: 'About Rozka · Built inside a working print shop',
    description: 'Roz ka kaam, roz ka hisaab: the everyday work and everyday accounts. Rozka was built inside a working print shop, for the owner still at the counter at 9 pm.',
    ldType: 'AboutPage',
    crumb: 'About',
  },
  contact: {
    path: '/contact/',
    title: 'Book a 1-month demo · Rozka',
    description: "Run Rozka on your own staff for a month. Tell us about your business and we'll call you back, set up the punch device at your place and put your rules in.",
    ldType: 'ContactPage',
    crumb: 'Book a demo',
  },
};

// Other English strings the build writes itself (structured data, language switcher, no-script fallbacks).
export const EXTRA_STRINGS = ['Home', 'Language', 'THE DAILY GRIND', 'FIXED FROM DAY ONE', 'WE COULD AUTOMATE NEXT', 'WHEN', 'THEN', 'RESULT'];

export const pageStrings = () => [...new Set([...Object.values(PAGES).flatMap((p) => [p.title, p.description, p.ogTitle, p.ogDescription, p.crumb].filter(Boolean)), ...EXTRA_STRINGS])];
