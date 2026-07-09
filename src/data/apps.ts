export interface FaqItem {
  question: string;
  answer: string;
}

export interface Screenshot {
  image: string;
  caption: string;
}

export interface AppData {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  shortDescription: string;
  image: string;
  screenshots: Screenshot[];
  problem: string;
  solution: string;
  whoItsFor: string[];
  prompt: string;
  ctaLabel: string;
  ctaHref: string;
  relatedSlugs: string[];
  faq: FaqItem[];
}

export interface Category {
  name: string;
  description: string;
  appSlugs: string[];
}

export const apps: AppData[] = [
  {
    slug: "orderly",
    name: "Orderly",
    tagline: "Order & Inventory Tracker",
    category: "Orders & Inventory",
    shortDescription:
      "Log customer orders, track stock levels, and get low-inventory alerts — no spreadsheet required.",
    image: "/images/orderly/cover.svg",
    screenshots: [
      { image: "/images/orderly/screenshot-1.svg", caption: "Order list view" },
      { image: "/images/orderly/screenshot-2.svg", caption: "Add new order form" },
      { image: "/images/orderly/screenshot-3.svg", caption: "Low stock alert" },
    ],
    problem:
      "Small business owners juggling orders across texts, notebooks, and spreadsheets lose track of what's been paid, what's shipped, and what's running low in stock — leading to missed orders and stockouts.",
    solution:
      "Orderly gives you one place to log every order, mark payment and fulfillment status, and track inventory counts per product. Get a simple low-stock warning before you run out.",
    whoItsFor: [
      "Home-based product sellers (candles, baked goods, crafts)",
      "Small retail shops managing limited stock",
      "Pop-up or market vendors tracking orders by hand",
    ],
    prompt:
      "Build a mini app called Orderly for small business owners. It should let me: (1) log new customer orders with product, quantity, price, and payment status, (2) track inventory levels per product with a manual count field, (3) show a simple dashboard listing all orders sorted by date with status badges (pending/paid/fulfilled), and (4) flag any product whose stock count drops below a set threshold. Keep the UI simple enough to use on a phone between customers.",
    ctaLabel: "Build Orderly with Whacka",
    ctaHref: "#",
    relatedSlugs: ["clientflow", "cardsnap"],
    faq: [
      {
        question: "Do I need coding experience to build this?",
        answer:
          "No — Whacka lets you describe what you need in plain language and generates the working app for you.",
      },
      {
        question: "Can I track more than one product type?",
        answer:
          "Yes, Orderly's inventory table supports unlimited products, each with its own stock count and threshold.",
      },
      {
        question: "Can I export my orders?",
        answer:
          "You can ask Whacka to add a CSV export feature at any time — mini apps are easy to extend.",
      },
    ],
  },
  {
    slug: "bookly",
    name: "Bookly",
    tagline: "Booking & Appointment Form",
    category: "Scheduling & Bookings",
    shortDescription:
      "Show your open slots and let customers reserve a time instantly — no back-and-forth texts.",
    image: "/images/bookly/cover.svg",
    screenshots: [
      { image: "/images/bookly/screenshot-1.svg", caption: "Booking calendar view" },
      { image: "/images/bookly/screenshot-2.svg", caption: "Customer booking form" },
      { image: "/images/bookly/screenshot-3.svg", caption: "Confirmation screen" },
    ],
    problem:
      "Service-based businesses waste hours a week going back and forth over text or DM to find a time that works, and often double-book or forget to confirm.",
    solution:
      "Bookly shows your available time slots on a simple calendar and lets customers pick and confirm a slot themselves — with your working hours and buffer time built in.",
    whoItsFor: [
      "Hairstylists, barbers, and beauty professionals",
      "Tutors and coaches",
      "Home service providers (cleaning, repair, pet grooming)",
    ],
    prompt:
      "Build a mini app called Bookly for a small service business. It should let me: (1) set my available days and hours plus a buffer time between appointments, (2) show customers a calendar of open slots, (3) let a customer pick a slot and submit their name, contact info, and service needed, and (4) show me a simple list of upcoming bookings sorted by date and time. Keep the booking form to one screen so it's fast on mobile.",
    ctaLabel: "Build Bookly with Whacka",
    ctaHref: "#",
    relatedSlugs: ["clientflow", "quotewave"],
    faq: [
      {
        question: "Can customers reschedule?",
        answer:
          "Yes, ask Whacka to add a reschedule or cancel link to the booking confirmation.",
      },
      {
        question: "Does it send reminders?",
        answer:
          "You can extend Bookly with email or SMS reminders — just describe the reminder timing you want.",
      },
      {
        question: "Can I limit how far ahead people can book?",
        answer:
          "Yes, set a booking window (e.g. next 14 days) as a rule when building it.",
      },
    ],
  },
  {
    slug: "quotewave",
    name: "QuoteWave",
    tagline: "Quote / Invoice Calculator",
    category: "Pricing & Quotes",
    shortDescription:
      "Turn your services and rates into an instant, professional quote you can send to customers.",
    image: "/images/quotewave/cover.svg",
    screenshots: [
      { image: "/images/quotewave/screenshot-1.svg", caption: "Quote builder form" },
      { image: "/images/quotewave/screenshot-2.svg", caption: "Instant price breakdown" },
      { image: "/images/quotewave/screenshot-3.svg", caption: "Shareable quote summary" },
    ],
    problem:
      "Many small businesses price jobs on the fly, leading to inconsistent quotes, forgotten line items, and awkward conversations about cost.",
    solution:
      "QuoteWave lets you set your services and rates once, then quickly build a quote by selecting items and quantities — instantly totaling tax, discounts, and fees into a clean summary you can share.",
    whoItsFor: [
      "Freelancers and contractors",
      "Cleaning, landscaping, and repair businesses",
      "Consultants who quote per project",
    ],
    prompt:
      "Build a mini app called QuoteWave for a small business that quotes jobs by service. It should let me: (1) set up a list of services with a default price for each, (2) build a quote by selecting services and quantities, (3) automatically calculate a subtotal, apply tax and an optional discount, and show a final total, and (4) generate a clean, shareable summary of the quote I can send to a customer. Keep it simple enough to fill out while standing at a job site.",
    ctaLabel: "Build QuoteWave with Whacka",
    ctaHref: "#",
    relatedSlugs: ["orderly", "bookly"],
    faq: [
      {
        question: "Can I save quote templates?",
        answer: "Yes, ask Whacka to let you save common service bundles as templates.",
      },
      {
        question: "Does it handle taxes for my region?",
        answer:
          "You can set a custom tax rate, or multiple rates if you charge different categories differently.",
      },
      {
        question: "Can I turn a quote into an invoice later?",
        answer: "Yes, that's a natural next step to add once the quote is accepted.",
      },
    ],
  },
  {
    slug: "clientflow",
    name: "ClientFlow",
    tagline: "Customer Request Tracker",
    category: "Customer Requests",
    shortDescription:
      "See every incoming customer request in one simple pipeline, from new to done.",
    image: "/images/clientflow/cover.svg",
    screenshots: [
      { image: "/images/clientflow/screenshot-1.svg", caption: "Request pipeline board" },
      { image: "/images/clientflow/screenshot-2.svg", caption: "New request form" },
      { image: "/images/clientflow/screenshot-3.svg", caption: "Request detail view" },
    ],
    problem:
      "Customer requests come in through calls, texts, emails, and walk-ins — with no single place to see what's new, in progress, or done, things fall through the cracks.",
    solution:
      "ClientFlow gives you one board where every request lands with a status (new, in progress, done) so you always know what needs attention next.",
    whoItsFor: [
      "Repair and maintenance businesses",
      "Agencies handling client requests",
      "Any business fielding requests from multiple channels",
    ],
    prompt:
      "Build a mini app called ClientFlow for a small business handling customer requests. It should let me: (1) log a new request with customer name, contact info, request details, and priority, (2) move each request through statuses (new, in progress, done), (3) show a simple board or list view grouped by status, and (4) let me add notes to a request as I work on it. Make it fast to add a new request from my phone.",
    ctaLabel: "Build ClientFlow with Whacka",
    ctaHref: "#",
    relatedSlugs: ["orderly", "bookly"],
    faq: [
      {
        question: "Can multiple people on my team use it?",
        answer:
          "Yes, you can extend ClientFlow with per-teammate assignment as your team grows.",
      },
      {
        question: "Can I prioritize urgent requests?",
        answer: "Yes, requests support a priority field so urgent items stand out.",
      },
      {
        question: "Does it notify me of new requests?",
        answer: "You can add email or notification alerts for new incoming requests.",
      },
    ],
  },
  {
    slug: "cardsnap",
    name: "CardSnap",
    tagline: "Product Catalog / Digital Menu",
    category: "Catalog & Menus",
    shortDescription:
      "A mobile-friendly digital catalog or menu you can share with a link — no printing required.",
    image: "/images/cardsnap/cover.svg",
    screenshots: [
      { image: "/images/cardsnap/screenshot-1.svg", caption: "Catalog grid view" },
      { image: "/images/cardsnap/screenshot-2.svg", caption: "Product detail card" },
      { image: "/images/cardsnap/screenshot-3.svg", caption: "Shareable link preview" },
    ],
    problem:
      "Printed menus and catalogs go out of date fast, and photos shared one-by-one over social media make it hard for customers to browse everything you offer.",
    solution:
      "CardSnap turns your products or menu items into a clean, browsable digital catalog with photos, prices, and descriptions — shareable with a single link.",
    whoItsFor: [
      "Restaurants and food vendors",
      "Retailers and boutique shops",
      "Service menus (salon services, package pricing)",
    ],
    prompt:
      "Build a mini app called CardSnap for a small business showcasing products or menu items. It should let me: (1) add products or items with a name, photo, price, and short description, (2) organize items into categories, (3) show a clean, mobile-friendly grid or list that customers can browse, and (4) generate a shareable link to the full catalog. Keep photos front and center.",
    ctaLabel: "Build CardSnap with Whacka",
    ctaHref: "#",
    relatedSlugs: ["quotewave", "clientflow"],
    faq: [
      {
        question: "Can I update prices anytime?",
        answer: "Yes, edit any item and the shared link reflects your changes instantly.",
      },
      {
        question: "Can customers order directly from the catalog?",
        answer:
          "Not by default, but you can extend CardSnap to link out to an order form like Orderly.",
      },
      {
        question: "Does it work well on mobile?",
        answer:
          "Yes, CardSnap is designed mobile-first since most customers will view it on their phone.",
      },
    ],
  },
];

export const categories: Category[] = [
  {
    name: "Orders & Inventory",
    description: "Track sales and stock levels without a spreadsheet.",
    appSlugs: ["orderly"],
  },
  {
    name: "Scheduling & Bookings",
    description: "Let customers reserve your time without the back-and-forth.",
    appSlugs: ["bookly"],
  },
  {
    name: "Pricing & Quotes",
    description: "Turn your rates into consistent, professional quotes.",
    appSlugs: ["quotewave"],
  },
  {
    name: "Customer Requests",
    description: "Keep every incoming request moving instead of lost in a thread.",
    appSlugs: ["clientflow"],
  },
  {
    name: "Catalog & Menus",
    description: "Show off what you sell with a shareable digital catalog.",
    appSlugs: ["cardsnap"],
  },
];

export function getAppBySlug(slug: string): AppData | undefined {
  return apps.find((app) => app.slug === slug);
}
