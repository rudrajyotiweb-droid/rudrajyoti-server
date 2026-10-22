/** Public JSON shapes — match client-site/src/data types so the UI needs minimal changes. */

export const templeCard = (t) =>
  t && typeof t === "object"
    ? { id: String(t._id), slug: t.slug, name: t.name, city: t.city, state: t.state, deity: t.deity, image: t.image, short: t.short }
    : null;

export const publicTemple = (t) => ({
  id: String(t._id),
  slug: t.slug,
  name: t.name,
  city: t.city,
  state: t.state,
  deity: t.deity,
  image: t.image,
  gallery: t.gallery?.length ? t.gallery : [t.image].filter(Boolean),
  short: t.short,
  history: t.history ?? [],
  timings: t.timings,
  mapQuery: t.mapQuery || `${t.name} ${t.city}`,
  coords: t.coords,
  seo: t.seo,
});

export const publicAddOn = (a) => ({ id: a.key, name: a.name, price: a.price, desc: a.desc, image: a.image });

export const publicPackage = (p) => ({ id: p.key, name: p.name, persons: p.persons, price: p.price, strike: p.strike, popular: !!p.popular, desc: p.desc });

const bookingOpen = (p) => p.status === "Published" && new Date(p.cutoff) > new Date();

export function publicPujaCard(p) {
  const temple = templeCard(p.temple);
  const prices = (p.packages ?? []).map((x) => x.price);
  return {
    id: String(p._id),
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle,
    ribbon: p.ribbon || undefined,
    deity: p.deity,
    purposes: p.purposes ?? [],
    templeSlug: temple?.slug ?? "",
    temple,
    date: p.date,
    cutoff: p.cutoff,
    tithi: p.tithi,
    images: p.images ?? [],
    devotees: p.devotees ?? 0,
    featured: !!p.featured,
    status: p.status,
    bookingOpen: bookingOpen(p),
    startingPrice: prices.length ? Math.min(...prices) : 0,
  };
}

export function publicPuja(p, addOnsMaster = []) {
  const byKey = new Map(addOnsMaster.map((a) => [a.key, a]));
  return {
    ...publicPujaCard(p),
    about: p.about ?? [],
    benefits: p.benefits ?? [],
    process: p.process ?? [],
    faqs: p.faqs ?? [],
    packages: (p.packages ?? []).map(publicPackage),
    addOns: (p.addOns ?? []).filter((k) => byKey.get(k)?.active).map((k) => publicAddOn(byKey.get(k))),
    boxContents: p.boxContents,
    seo: p.seo,
    bn: p.bn,
  };
}

export function publicChadhava(c, full = true) {
  const temple = templeCard(c.temple);
  const base = {
    id: String(c._id),
    slug: c.slug,
    title: c.title,
    subtitle: c.subtitle,
    templeSlug: temple?.slug ?? "",
    temple,
    date: c.date,
    cutoff: c.cutoff,
    tithi: c.tithi,
    image: c.image,
    devotees: c.devotees ?? 0,
    status: c.status,
    bookingOpen: c.status === "Published" && new Date(c.cutoff ?? c.date) > new Date(),
    startingPrice: c.items?.length ? Math.min(...c.items.map((i) => i.price)) : 0,
  };
  if (!full) return base;
  return {
    ...base,
    about: c.about,
    items: (c.items ?? []).map((i) => ({ id: i.key, name: i.name, price: i.price, image: i.image, desc: i.desc, available: i.limit > 0 ? Math.max(0, i.limit - (i.sold ?? 0)) : null })),
  };
}

export function publicProduct(p) {
  return {
    id: String(p._id),
    slug: p.slug,
    name: p.name,
    category: p.category,
    price: p.price,
    mrp: p.mrp,
    gst: p.gst,
    rating: p.rating,
    reviews: p.reviews,
    images: p.images ?? [],
    short: p.short,
    description: p.description,
    specs: p.specs ?? [],
    howToUse: p.howToUse || undefined,
    variants: p.variants?.options?.length ? p.variants : undefined,
    badge: p.badge || undefined,
    bestseller: !!p.bestseller,
    stock: p.stock,
    seo: p.seo,
  };
}

export const publicCategory = (c) => ({ id: String(c._id), slug: c.slug, name: c.name, icon: c.icon, image: c.image, parent: c.parent ?? null });

export const publicReview = (r) => ({
  id: String(r._id),
  name: r.customerName || "Devotee",
  city: r.city,
  rating: r.rating,
  text: r.text,
  target: r.target,
  kind: r.kind,
  reply: r.reply || undefined,
  date: r.createdAt,
  isDemo: !!r.isDemo,
});
