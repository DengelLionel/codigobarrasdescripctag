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
 * 🔢 Genera un código de barras único EAN-13 válido
 */
function generateUniqueBarcode(productId, index) {
  // Usar el ID del producto y un índice para generar un código único
  // Formato: 200 + productId (últimos 6 dígitos) + index (3 dígitos) + dígito de control
  
  const baseCode = `200${String(productId).padStart(6, '0').slice(-6)}${String(index).padStart(3, '0')}`;
  
  // Calcular dígito de control EAN-13
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(baseCode[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  
  const checkDigit = (10 - (sum % 10)) % 10;
  return baseCode + checkDigit;
}

/**
 * 🔍 Verificar si un código de barras ya existe en Shopify
 */
async function barcodeExists(SHOP, API_VERSION, TOKEN, barcode) {
  try {
    const res = await shopifyFetch(
      `https://${SHOP}/admin/api/${API_VERSION}/products.json?limit=1&fields=id&variants.barcode=${barcode}`,
      {
        headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
      }
    );
    
    const data = await res.json();
    return data.products && data.products.length > 0;
  } catch (error) {
    console.warn(`⚠️ Error verificando código de barras ${barcode}:`, error.message);
    return false;
  }
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

/**
 * 📋 Obtener todos los códigos de barras existentes
 */
async function getExistingBarcodes(products) {
  const existingBarcodes = new Set();
  
  products.forEach(product => {
    product.variants?.forEach(variant => {
      if (variant.barcode) {
        existingBarcodes.add(variant.barcode);
      }
    });
  });
  
  return existingBarcodes;
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
    
    // Obtener códigos de barras existentes para evitar duplicados
    const existingBarcodes = await getExistingBarcodes(products);
    console.log(`🔢 Códigos de barras existentes: ${existingBarcodes.size}`);

    let updated = [];
    let barcodesGenerated = 0;

    for (let productIndex = 0; productIndex < products.length; productIndex++) {
      const product = products[productIndex];
      
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

      // 📝 Descripción (mantenemos la funcionalidad original)
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

      // 🔢 Generar códigos de barras únicos para variantes sin código
      const updatedVariants = [];
      
      for (let variantIndex = 0; variantIndex < product.variants.length; variantIndex++) {
        const variant = product.variants[variantIndex];
        
        // Solo generar código de barras si no tiene uno
        if (!variant.barcode) {
          let newBarcode;
          let attempts = 0;
          const maxAttempts = 100;
          
          // Generar código único que no exista
          do {
            newBarcode = generateUniqueBarcode(product.id, productIndex * 100 + variantIndex + attempts);
            attempts++;
          } while (existingBarcodes.has(newBarcode) && attempts < maxAttempts);
          
          if (attempts >= maxAttempts) {
            console.warn(`⚠️ No se pudo generar código único para variante ${variant.id} después de ${maxAttempts} intentos`);
            continue;
          }
          
          // Agregar al set para evitar duplicados en esta ejecución
          existingBarcodes.add(newBarcode);
          
          updatedVariants.push({
            id: variant.id,
            barcode: newBarcode
          });
          
          barcodesGenerated++;
          console.log(`🔢 Nuevo código de barras para "${product.title}" (Variante ${variant.id}): ${newBarcode}`);
        }
      }

      // 🔄 Preparar payload de actualización
      const updatePayload = {
        product: {
          id: product.id,
          body_html: description
        }
      };

      // Agregar variantes solo si hay códigos de barras que actualizar
      if (updatedVariants.length > 0) {
        updatePayload.product.variants = updatedVariants;
      }

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
            body: JSON.stringify(updatePayload),
          }
        );

        console.log(`✅ Actualizado: ${product.title} ${updatedVariants.length > 0 ? `(${updatedVariants.length} códigos de barras generados)` : ''}`);
        updated.push(product.title);
      } catch (err) {
        console.error(`❌ Error al actualizar ${product.title}:`, err.message);
      }

      await sleep(500); // Aumentamos un poco la espera por seguridad
    }

    console.log(`\n🎉 Actualización completada!`);
    console.log(`📦 Total productos actualizados: ${updated.length}`);
    console.log(`🔢 Total códigos de barras generados: ${barcodesGenerated}`);
    
  } catch (e) {
    console.error("❌ Error general:", e.message || e);
  }
}

// Ejecutar
updateProducts();