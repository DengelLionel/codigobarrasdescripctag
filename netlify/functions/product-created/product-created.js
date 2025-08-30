// netlify/functions/product-created.js
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verificar la autenticidad del webhook de Shopify
 */
function verifyWebhook(data, hmacHeader) {
  const calculated = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(data, 'utf8')
    .digest('base64');
  
  return calculated === hmacHeader;
}

/**
 * Helper para requests con manejo de rate limit
 */
async function shopifyFetch(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
        console.warn(`Rate limit alcanzado. Reintentando en ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`${res.status}: ${errorText}`);
      }

      return res;
      
    } catch (error) {
      console.error(`Error en request ${i + 1}/${retries}:`, error.message);
      if (i === retries - 1) throw error;
      await sleep(1000);
    }
  }
}

/**
 * Genera un código de barras único EAN-13 válido
 */
function generateUniqueBarcode(productId, variantIndex = 0) {
  const baseCode = `200${String(productId).padStart(6, '0').slice(-6)}${String(variantIndex).padStart(3, '0')}`;
  
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(baseCode[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  
  const checkDigit = (10 - (sum % 10)) % 10;
  return baseCode + checkDigit;
}

/**
 * Generar descripción del producto basada en tags
 */
function generateProductDescription(product) {
  const tags = product.tags.split(",").map((t) => t.trim().toLowerCase());
  const tagMatch = tags.find((t) =>
    [
      "all-jumpers",
      "water-slides", 
      "combos-wet-dry",
      "combos wet/dry",
      "interactives",
      "obstacle courses",
      "slide combos",
    ].includes(t)
  );

  if (!tagMatch) {
    return `
      <div class="product-description">
        <p>High-quality product from Tago's Jump Inc. Built with commercial-grade materials for durability and performance.</p>
        <p>Perfect for events, parties, and commercial use. Trust in our commitment to quality and customer satisfaction.</p>
      </div>
    `;
  }

  return `
    <div class="product-usp">
      Take Your Business to the Next Level with Tago's Jump Inc.<br>
      With any inflatable ${tagMatch} from Tago's Jump Inc., you can rest easy knowing you're getting a top-of-the-line, commercial-grade inflatable that's built to last and maximize your investment.<br><br>

      The ${product.title} is no exception. It's the perfect option for any event where people want to cool off and have some adrenaline-pumping fun. With a spectacular design and vibrant color scheme, the ${product.title} adds a pop of excitement and visual appeal to any party, ensuring your customers come back for more.<br><br>

      The ${product.title} from Tago's Jump Inc. is an ideal choice for any event.<br>
    </div>
  `;
}

/**
 * Procesar producto nuevo
 */
async function processNewProduct(product) {
  const SHOP = process.env.SHOPIFY_SHOP;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

  console.log(`Procesando: ${product.title} (${product.variants.length} variantes)`);

  // Generar códigos de barras para variantes que no tienen
  const updatedVariants = [];
  let barcodesGenerated = 0;

  product.variants.forEach((variant, index) => {
    if (!variant.barcode) {
      const newBarcode = generateUniqueBarcode(product.id, index);
      updatedVariants.push({
        id: variant.id,
        barcode: newBarcode
      });
      barcodesGenerated++;
      console.log(`Código generado: ${newBarcode} para variante ${variant.id}`);
    }
  });

  // Preparar payload de actualización
  const updatePayload = { product: { id: product.id } };

  // Agregar descripción si no existe
  if (!product.body_html || product.body_html.trim() === '') {
    updatePayload.product.body_html = generateProductDescription(product);
    console.log(`Descripción generada (${updatePayload.product.body_html.length} caracteres)`);
  }

  // Agregar códigos de barras
  if (updatedVariants.length > 0) {
    updatePayload.product.variants = updatedVariants;
  }

  // Solo actualizar si hay cambios
  if (!updatePayload.product.body_html && updatedVariants.length === 0) {
    console.log(`Producto ${product.title} ya está completo`);
    return { success: true, changes: false };
  }

  try {
    console.log(`Actualizando en Shopify...`);
    
    const response = await shopifyFetch(
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

    const responseData = await response.json();
    
    console.log(`ÉXITO: ${product.title} actualizado`);
    console.log(`  Descripción: ${updatePayload.product.body_html ? 'Sí' : 'No'}`);
    console.log(`  Códigos: ${barcodesGenerated}`);

    return { 
      success: true, 
      changes: true, 
      barcodesGenerated,
      descriptionAdded: !!updatePayload.product.body_html 
    };

  } catch (error) {
    console.error(`Error actualizando ${product.title}:`, error.message);
    
    // Si falla la actualización completa, intentar solo variantes
    if (updatedVariants.length > 0) {
      console.log(`Intentando actualizar solo códigos de barras...`);
      
      let variantsUpdated = 0;
      for (const variant of updatedVariants) {
        try {
          await shopifyFetch(
            `https://${SHOP}/admin/api/${API_VERSION}/variants/${variant.id}.json`,
            {
              method: "PUT",
              headers: {
                "X-Shopify-Access-Token": TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                variant: {
                  id: variant.id,
                  barcode: variant.barcode
                }
              }),
            }
          );
          console.log(`Código ${variant.barcode} aplicado a variante ${variant.id}`);
          variantsUpdated++;
        } catch (variantError) {
          console.error(`Error en variante ${variant.id}:`, variantError.message);
        }
      }
      
      return { 
        success: variantsUpdated > 0, 
        changes: variantsUpdated > 0,
        barcodesGenerated: variantsUpdated,
        descriptionAdded: false,
        partial: true
      };
    }
    
    throw error;
  }
}

/**
 * Handler principal para Netlify
 */
exports.handler = async (event, context) => {
  // Solo aceptar POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  const startTime = Date.now();

  try {
    console.log(`Webhook recibido: ${new Date().toISOString()}`);

    // Verificar autenticidad si está configurada
    const hmacHeader = event.headers['x-shopify-hmac-sha256'];
    if (process.env.SHOPIFY_WEBHOOK_SECRET && hmacHeader) {
      if (!verifyWebhook(event.body, hmacHeader)) {
        console.error('Webhook no auténtico');
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'No autorizado' })
        };
      }
    }

    // Parsear producto
    const product = JSON.parse(event.body);
    
    if (!product || !product.id) {
      console.error('Datos del producto inválidos');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Datos inválidos' })
      };
    }

    console.log(`Producto: ${product.title} (ID: ${product.id})`);

    // Procesar el producto
    const result = await processNewProduct(product);
    
    const duration = Date.now() - startTime;
    console.log(`Proceso completado en ${duration}ms`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Hmac-Sha256'
      },
      body: JSON.stringify({ 
        success: result.success,
        message: result.changes ? 'Producto procesado y actualizado' : 'Producto recibido, sin cambios necesarios',
        productId: product.id,
        productTitle: product.title,
        barcodesGenerated: result.barcodesGenerated || 0,
        descriptionAdded: result.descriptionAdded || false,
        partial: result.partial || false,
        processingTime: duration,
        timestamp: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('Error en webhook handler:', error.message);
    const duration = Date.now() - startTime;
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        error: 'Error interno del servidor',
        message: error.message,
        processingTime: duration
      })
    };
  }
};