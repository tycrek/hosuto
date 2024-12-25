import { Hono } from 'hono';
import Cloudflare from 'cloudflare';

type Image = Cloudflare.Images.Image;

/**
 * Hono app
 */
const app = new Hono<{
	Bindings: {
		/**
		 * Static asset fetcher
		 */
		ASSETS: Fetcher;
		/**
		 * KV binding
		 */
		KV: KVNamespace;

		CLOUDFLARE_EMAIL: string;
		CLOUDFLARE_API_KEY: string;
		CLOUDFLARE_ACCOUNT_ID: string;
	};
	Variables: {
		cf: Cloudflare;
		images: Image[];
	};
}>({ strict: false });

const bytesToMiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

/**
 * Check if the provided timestamp is expired
 */
const isExpired = (lastUpdated: string | null) => {
	//  1 hour: 1000 * 60 * 60
	//  30 sec: 1000 * 30
	// 24 hour: 1000 * 60 * 60 * 24
	return !lastUpdated || new Date(lastUpdated).getTime() < new Date().getTime() - 1000 * 60 * 60 * 24;
};

/**
 * Get all images recursively
 */
const getImages = async (cf: Cloudflare, accountId: string, token?: string): Promise<Image[]> => {
	const { images = [], continuation_token } = await cf.images.v2.list({
		account_id: accountId,
		continuation_token: token,
	});
	return images.concat(continuation_token ? await getImages(cf, accountId, continuation_token) : []);
};

/**
 * Update the cache with a set of images
 */
const updateCache = async (kv: KVNamespace, images: Image[]) => {
	const date = new Date().toISOString();
	await Promise.all([
		kv.put('KV_CACHE', JSON.stringify(images)),
		kv.put('KV_LAST_UPDATED', date),
	]);
	return date;
};

/**
 * Get images, whichever way is most optimal
 */
const getImagesCheckingCache = async (cf: Cloudflare, kv: KVNamespace, accountId: string) => {
	const images: Image[] = [];

	// Check if expired
	const expired = isExpired(await kv.get('KV_LAST_UPDATED'));
	if (expired) {
		images.push(...await getImages(cf, accountId));

		// Update cache
		await updateCache(kv, images);
	} else images.push(...JSON.parse(await kv.get('KV_CACHE') ?? '[]') as unknown as Image[]);

	return images;
};

/**
 * Middleware to attach a Cloudflare object to every request
 */
app.use(async (ctx, next) => {
	const cf = new Cloudflare({ apiEmail: ctx.env.CLOUDFLARE_EMAIL, apiToken: ctx.env.CLOUDFLARE_API_KEY });
	ctx.set('images', await (getImagesCheckingCache(cf, ctx.env.KV, ctx.env.CLOUDFLARE_ACCOUNT_ID)));
	ctx.set('cf', cf);
	await next();
});

/**
 * Updates the KV cache
 */
app.get('/.update', async (ctx) => {
	const images = await getImages(ctx.get('cf'), ctx.env.CLOUDFLARE_ACCOUNT_ID);
	return ctx.json({
		updated: await updateCache(ctx.env.KV, images),
		size: `${bytesToMiB(JSON.stringify(images).length)} MiB`,
	});
});

/**
 * Attemps to find and serve a requested image
 */
app.get('/:image/:variant?', async (ctx) => {
	const imageNeedle = ctx.req.param('image');
	const variantNeedle = ctx.req.param('variant') ?? 'public';

	// Find image
	const image = ctx.get('images')
		.find((img) => img.filename!.startsWith(imageNeedle) || img.id!.startsWith(imageNeedle));
	if (!image) {
		ctx.status(404);
		return ctx.text(`Image not found: ${imageNeedle}`);
	}

	// Find variant
	const variantUrl = image.variants!.find((v) => v.endsWith(variantNeedle));
	if (!variantUrl) {
		ctx.status(404);
		return ctx.text(`Image not found: ${imageNeedle}/${variantNeedle}`);
	}

	// Get byte data of the original image
	const originalResponse = await fetch(variantUrl);

	// Clone the response so it's no longer immutable
	const nres = new Response(originalResponse.body, originalResponse);

	// Header: original filename
	nres.headers.append('Content-Disposition', `inline; filename="${image.filename}"`);

	// Header: 90-day cache
	nres.headers.append('Cache-Control', 'public, max-age=7776000');

	// Headers: original image URL and ID
	nres.headers.append('X-Original-Url', variantUrl);
	nres.headers.append('X-Image-Id', image.id!);

	return nres;
});

// Fallback route
app.get('/', (ctx) => ctx.redirect('https://github.com/tycrek/hosuto', 301));

export default app;
