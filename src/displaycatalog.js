/**
 * Minimal client for the Microsoft Store DisplayCatalog API.
 *
 * Modelled after the request/response shapes used by xodus:
 * https://github.com/xodus-gaming/xodus/blob/main/xodus/src/api/displaycatalog.rs
 *
 * The public endpoint is:
 *   GET https://displaycatalog.mp.microsoft.com/v7.0/products/{productId}
 *       ?market={market}&languages={languages}&fieldsTemplate=details
 *
 * The relevant JSON nesting paths (PascalCase, as returned by the API):
 *   Product
 *     - LocalizedProperties[].ProductTitle / PublisherName
 *     - DisplaySkuAvailabilities[]
 *         - Availabilities[].Conditions.ClientConditions.AllowedPlatforms[].PlatformName
 *         - Sku.Properties.Packages[]
 *             - PackageFormat
 *             - ContentId / FulfillmentData.PackageContentId
 *             - PlatformDependencies[].PlatformName
 */

const DISPLAYCATALOG_BASE = "https://displaycatalog.mp.microsoft.com/v7.0/products";

/**
 * Fetch the raw DisplayCatalog response for a single product id.
 *
 * @param {string} productId - The Store product id (e.g. "9NBLGGH4R315").
 * @param {object} [options]
 * @param {string} [options.market] - Two letter market code, default "US".
 * @param {string|string[]} [options.languages] - Language code(s), default "en-us".
 * @returns {Promise<object>} The parsed JSON response.
 */
export async function fetchProduct(productId, options = {}) {
  const { market = "US", languages = "en-us" } = options;
  const langParam = Array.isArray(languages) ? languages.join(",") : languages;

  const url = new URL(`${DISPLAYCATALOG_BASE}/${encodeURIComponent(productId)}`);
  url.searchParams.set("market", market);
  url.searchParams.set("languages", langParam);
  url.searchParams.set("fieldsTemplate", "details");

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      // A correlation vector is optional but accepted by the service.
      "MS-CV": "DGU1mcuYo0WMMp+F.1",
    },
  });

  if (res.status === 404) {
    throw new Error(`No product found for id "${productId}" in market "${market}".`);
  }
  if (!res.ok) {
    throw new Error(
      `DisplayCatalog request failed: ${res.status} ${res.statusText}`,
    );
  }

  return res.json();
}

/**
 * Distil the verbose DisplayCatalog response into the pieces we want to show:
 * platforms, package formats and content ids (plus a little extra metadata).
 *
 * @param {object} data - The raw response from {@link fetchProduct}.
 * @returns {{
 *   productId: string|undefined,
 *   title: string,
 *   publisher: string|undefined,
 *   productType: string|undefined,
 *   platforms: string[],
 *   formats: string[],
 *   contentIds: string[],
 *   packages: Array<{
 *     format: string|undefined,
 *     contentId: string|undefined,
 *     version: string|undefined,
 *     packageFamilyName: string|undefined,
 *     wuCategoryId: string|undefined,
 *     platforms: string[],
 *   }>,
 * }}
 */
export function summarizeProduct(data) {
  const product = data?.Product;
  if (!product) {
    throw new Error("Unexpected DisplayCatalog response: missing `Product`.");
  }

  const localized = product.LocalizedProperties?.[0] ?? {};

  const platforms = new Set();
  const formats = new Set();
  const contentIds = [];
  const packages = [];

  for (const dsa of product.DisplaySkuAvailabilities ?? []) {
    // Platforms advertised on the availabilities (client conditions).
    for (const availability of dsa.Availabilities ?? []) {
      const allowed =
        availability.Conditions?.ClientConditions?.AllowedPlatforms ?? [];
      for (const platform of allowed) {
        if (platform.PlatformName) platforms.add(platform.PlatformName);
      }
    }

    // Packages live under the SKU properties and carry formats + content ids.
    const skuPackages = dsa.Sku?.Properties?.Packages ?? [];
    for (const pkg of skuPackages) {
      if (pkg.PackageFormat) formats.add(pkg.PackageFormat);

      const pkgPlatforms = [];
      for (const dep of pkg.PlatformDependencies ?? []) {
        if (dep.PlatformName) {
          platforms.add(dep.PlatformName);
          pkgPlatforms.push(dep.PlatformName);
        }
      }

      const contentId = pkg.ContentId ?? pkg.FulfillmentData?.PackageContentId;
      if (contentId) contentIds.push(contentId);

      packages.push({
        format: pkg.PackageFormat,
        contentId,
        version: pkg.Version,
        packageFamilyName:
          pkg.PackageFamilyName ?? pkg.FulfillmentData?.PackageFamilyName,
        wuCategoryId: pkg.FulfillmentData?.WuCategoryId,
        platforms: pkgPlatforms,
      });
    }
  }

  return {
    productId: product.ProductId,
    title: localized.ProductTitle || "Unknown title",
    publisher: localized.PublisherName,
    productType: product.ProductType,
    platforms: [...platforms],
    formats: [...formats],
    contentIds: [...new Set(contentIds)],
    packages,
  };
}
