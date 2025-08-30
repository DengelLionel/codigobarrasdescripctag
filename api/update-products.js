// api/update-products.js
import fetch from "node-fetch";
import "dotenv/config";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Helper para requests con manejo de rate limit (429)
 */
async function shopifyFetch(url, options = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      // Demasiadas peticiones → esperar el tiempo recomendado
      const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
      console.warn(`⏳ Rate limit alcanzado. Reintentando en ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    return res;
  }

  throw new Error(`❌ Fallaron ${retries} reintentos para ${url}`);
}

/**
 * 🔄 Obtener TODOS los productos de Shopify (paginación con page_info)
 */
async function fetchAllProducts(SHOP, API_VERSION, TOKEN) {
  let allProducts = [];
  let url = `https://${SHOP}/admin/api/${API_VERSION}/products.json?limit=250`;

  while (url) {
    const res = await shopifyFetch(url, {
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    });

    const data = await res.json();
    allProducts = allProducts.concat(data.products);

    const linkHeader = res.headers.get("link");
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>; rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  return allProducts;
}

async function updateProducts() {
  const SHOP = process.env.SHOPIFY_SHOP;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

  if (!SHOP || !TOKEN) {
    console.error("❌ Faltan las variables de entorno de Shopify.");
    return;
  }

  try {
    const products = await fetchAllProducts(SHOP, API_VERSION, TOKEN);
    console.log(`📦 Productos encontrados: ${products.length}`);

    let updated = [];

    for (const product of products) {
      const tags = product.tags.split(",").map((t) => t.trim().toLowerCase());
      const tagMatch = tags.find((t) =>
        [
          "all-jumpers",
          "water-slides",
          "combos-wet-dry",
          "combos wet/dry",
          "interactives",
          "obstacle courses",
          "Obstacle Courses",
          "slide combos",
          "Slide Combos",
        ].includes(t)
      );

      if (!tagMatch) continue;

      // 🔍 Obtener metacampos
      const metafieldsRes = await shopifyFetch(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${product.id}/metafields.json`,
        { headers: { "X-Shopify-Access-Token": TOKEN } }
      );

      const { metafields = [] } = await metafieldsRes.json();
      const getMeta = (nsKey) =>
        metafields.find((m) => m.namespace === "custom" && m.key === nsKey)?.value || "";

      const dimensions = getMeta("dimensions");
      const includes = getMeta("includes");
      const warranty = getMeta("warranty");

      // 📝 Descripción
      const description = `
        <div class="product-usp">
          Take Your Business to the Next Level with Tago's Jump Inc.<br>
          With any inflatable ${tagMatch} from Tago's Jump Inc., you can rest easy knowing you're getting a top-of-the-line, commercial-grade inflatable that's built to last and maximize your investment.<br><br>

          The ${product.title} is no exception. It's the perfect option for any event where people want to cool off and have some adrenaline-pumping fun. With a spectacular design and vibrant color scheme, the ${product.title} adds a pop of excitement and visual appeal to any party, ensuring your customers come back for more.<br><br>

          The ${product.title} from Tago's Jump Inc. is an ideal choice for any event.<br>
          ${dimensions ? `<strong>Dimensions:</strong> ${dimensions}<br>` : ""}
          ${includes ? `<strong>Includes:</strong> ${includes}<br>` : ""}
          ${warranty ? `<strong>Warranty:</strong> ${warranty}` : ""}
        </div>
      `;

      // 🔄 Actualizar producto
      try {
        await shopifyFetch(
          `https://${SHOP}/admin/api/${API_VERSION}/products/${product.id}.json`,
          {
            method: "PUT",
            headers: {
              "X-Shopify-Access-Token": TOKEN,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ product: { id: product.id, body_html: description } }),
          }
        );

        console.log(`✅ Actualizado: ${product.title}`);
        updated.push(product.title);
      } catch (err) {
        console.error(`❌ Error al actualizar ${product.title}:`, err.message);
      }

      await sleep(300); // un poco más de espera por seguridad
    }

    console.log(`\n🎉 Actualización completada. Total productos actualizados: ${updated.length}`);
  } catch (e) {
    console.error("❌ Error general:", e.message || e);
  }
}

// Ejecutar
updateProducts();
