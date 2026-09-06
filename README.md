This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Local testing against the live database

No Docker or local Postgres is needed. `.env` already points at the
DigitalOcean managed Postgres, so the app runs on this machine against the
real data. Test every change here before pushing — each push triggers a
DigitalOcean App Platform build and burns build minutes.

One-time: DigitalOcean only accepts connections from IPs listed under
**Databases -> your cluster -> Settings -> Trusted Sources**. Add this
machine's public IP there (it changes when your ISP reassigns it; re-add if
`prisma migrate status` reports P1001 "Can't reach database server").

```bash
npm run dev          # hot-reloading dev server on http://localhost:3000
npm run check        # what the DO build runs: typecheck, lint, prisma generate, next build
npm run start:local  # serve the production build locally WITHOUT running migrations
```

Never use plain `npm start` locally: it runs `prisma migrate deploy` against
the live database, which is the production deploy step.

## Getting Started


First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
