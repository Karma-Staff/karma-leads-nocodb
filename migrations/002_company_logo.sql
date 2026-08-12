-- Companies scraped off job postings carry the employer's logo. The URL points
-- at the job source's CDN (LinkedIn media) — we store the link, not the image,
-- and the front end falls back to the initials circle if it ever goes stale.
ALTER TABLE leads ADD COLUMN logo_url text;
