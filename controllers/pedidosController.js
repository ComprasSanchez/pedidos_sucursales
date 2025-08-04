// controllers/pedidosController.js
const axios = require('axios');
const xml2js = require('xml2js');
const { stripPrefix } = require('xml2js').processors;
const { db, plex } = require('../db');
const QUANTIO_URL = 'http://sanchezantoniolli.quantio.com.ar:8081/wsquantiorest';
// Cache en memoria por sucursal (evita logins repetidos)
const monroeTokenCache = new Map(); // key: sucursal, value: { token, exp: ms }
const MONROE_TOKEN_TTL_MS = 4 * 60 * 1000; // 4 minutos (ellos dan 300s)


    async function fetchQuantio(ean, sucursal) {
  try {
    // 1) Credenciales desde tu tabla credenciales_droguerias usando db
    const [credRows] = await db.query(`
      SELECT
        quantio_usuario AS usuario,
        quantio_clave   AS clave
      FROM credenciales_droguerias
      WHERE sucursal_codigo = ?
    `, [sucursal]);
    if (!credRows.length) throw new Error('Credenciales Quantio no encontradas');
    const { usuario, clave } = credRows[0];

    // 2) Lookup de CodPlex en la BD Plex
    const [prodRows] = await plex.query(`
      SELECT pc.idproducto AS codPlex
      FROM productoscodebars pc
      WHERE pc.codebar = ?
    `, [ean]);
    if (!prodRows.length) {
      console.warn(`Quantio: no existe codebar ${ean} en Plex`);
      return { stock: false };
    }
    const codPlex = String(prodRows[0].codPlex);

    // 3) Armar payload (sucursal 1 fijo)
    const payload = {
      request: {
        type: 'CONSULTAR_STOCK',
        content: {
          sucursal: '1',
          productos: codPlex
        }
      }
    };
    console.log('➡️ Quantio payload:', JSON.stringify(payload));

    // 4) Llamada al servicio
    const url = 'http://sanchezantoniolli.quantio.com.ar:8081/wsquantiorest';
    const response = await axios.post(url, payload, {
      auth: { username: usuario, password: clave },
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('⬅️ Quantio response.data:', response.data);

    // 5) Extraer stock
    const productos = response.data?.response?.content?.productos;
    if (!Array.isArray(productos)) throw new Error('Formato inesperado de Quantio');
    const item = productos.find(p => String(p.id) === codPlex);
    const hasStock = Boolean(item && parseInt(item.stock, 10) > 0);

    return { stock: hasStock, idproducto: codPlex };
  }
  catch (err) {
    if (err.response) {
      console.error('❌ Quantio HTTP:', err.response.status, err.response.data);
    }
    console.error('Quantio error:', err.message);
    return { stock: false };
  }
  
}


async function crearPedidoQuantio(tabla, sucursal) {
  // Buscar credenciales de Quantio desde la DB
  const [credRows] = await db.query(`
    SELECT
      quantio_usuario AS usuario,
      quantio_clave   AS clave
    FROM credenciales_droguerias
    WHERE sucursal_codigo = ?
  `, [sucursal]);

  if (!credRows.length) {
    return { error: '❌ No se encontraron credenciales de Quantio para esta sucursal.' };
  }

  const { usuario, clave } = credRows[0];

  // Armar los productos seleccionados
  const productosQuantio = tabla
  .filter(row => row.seleccionado === 'quantio' && row.quantio?.idproducto)
  .map(row => ({
    idproducto: String(row.quantio.idproducto),
    cantidad: String(row.cantidad || 1),
    ordenplex: ''
  }));

  if (productosQuantio.length === 0) {
    return { error: 'No hay productos seleccionados en Quantio para pedir.' };
  }

  // Armar el body del pedido
  const body = {
    request: {
      type: 'CREAR_PEDIDO',
      content: {
        productos: productosQuantio
      }
    }
  };

  try {
    const resp = await axios.post(QUANTIO_URL, body, {
      auth: { username: usuario, password: clave },
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    console.log('✅ Pedido enviado a Quantio:', resp.data);
    return { ok: true, resultado: resp.data };
  } catch (err) {
    console.error('❌ Error al crear pedido en Quantio:', err?.response?.data || err.message);
    return {
      error: 'Fallo al crear el pedido en Quantio',
      detalle: err?.response?.data || err.message
    };
  }
}





// Monroe (login + consultarStock)
async function fetchMonroe(ean, sucursal, cantidad) {
  try {
    const [credRows] = await db.query(`
      SELECT monroe_software_key, monroe_ecommerce_key, monroe_cuenta
      FROM credenciales_droguerias
      WHERE sucursal_codigo = ?
    `, [sucursal]);
    if (!credRows.length) throw new Error('Credenciales Monroe no encontradas');
    const { monroe_software_key, monroe_ecommerce_key, monroe_cuenta } = credRows[0];

    // --- NUEVO: usar cache de token ---
    const now = Date.now();
    let token = null;
    const cached = monroeTokenCache.get(sucursal);
    if (cached && cached.exp > now) {
      token = cached.token;
    } else {
      const loginRes = await axios.get(
        'https://servicios.monroeamericana.com.ar/api-cli/Auth/login',
        {
          params: {
            software_key: monroe_software_key,
            token_duration: 300,
            ecommerce_customer_key: monroe_ecommerce_key,
            ecommerce_customer_reference: monroe_cuenta
          }
        }
      );
      token = loginRes.data.token ?? loginRes.data.access_token;
      if (!token) {
        console.error('❌ Monroe Login Response completo:', JSON.stringify(loginRes.data, null, 2));
        throw new Error('Token Monroe vacío');
      }
      monroeTokenCache.set(sucursal, { token, exp: now + MONROE_TOKEN_TTL_MS });
    }
    // --- FIN NUEVO ---

    const body = {
      referencia_cliente: `pedido-${Date.now()}`,
      arrayProductos: [{
        orden: 1,
        unidades: cantidad.toString(),
        arrayCodigos: { CodigoBarras: ean, Nombre: '' }
      }]
    };

    const stockRes = await axios.post(
      'https://servicios.monroeamericana.com.ar/api-cli/ade/1.0.0/consultarStock',
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const prod = stockRes.data.arrayProductos?.[0];
    if (!prod || prod.Stock?.estado !== 1) {
      return { stock: false, priceList: null, offerPrice: null, offers: [], token }; // ← devolvemos token igual
    }

    const priceList = prod.Precio.lista;
    const rawOffers = Array.isArray(prod.arrayOfertas) ? prod.arrayOfertas : [];
    const offers = [];

    for (const o of rawOffers) {
      const minU = o.Condicion_Compra?.minimo_unids ?? 0;
      const maxU = o.Condicion_Compra?.maximo_unids ?? Infinity;
      if (cantidad < minU || cantidad > maxU) continue;
      const pct = o.Descuento?.porcentaje ?? 0;
      let leyenda = `${pct}%`;
      if (o.Condicion_Compra?.minimo_unids) {
        leyenda += ` min ${o.Condicion_Compra.minimo_unids} unidades`;
      }
      offers.push({
        descripcion: leyenda,
        Condicion_Compra: {
          minimo_unids: o.Condicion_Compra?.minimo_unids ?? 1
        }
      });
    }

    let offerPrice = null;
    if (offers.length) {
      offerPrice = offers.reduce((best, o) => {
        const pctMatch = o.descripcion.match(/(\d+)%/);
        const pct = pctMatch ? parseFloat(pctMatch[1]) : 0;
        const after = priceList * (1 - pct / 100);
        return best === null ? after : Math.min(best, after);
      }, null);
    }

    // ←←← DEVOLVEMOS token también
    return {
      stock: true,
      priceList,
      offerPrice,
      offers,
      token
    };
  } catch (err) {
    console.error('Monroe error:', err.message);
    return { stock: null, priceList: null, offerPrice: null, offers: [], token: null };
  }
}



async function crearPedidoMonroe(tabla, sucursal, { referencia = null, fechaEntrega = null } = {}) {
  const items = tabla
    .filter(r => r.seleccionado === 'monroe')
    .map((r, idx) => ({
      orden: idx + 1,
      unidades: String(r.cantidad || 1),
      arrayCodigos: {
        CodigoBarras: r.codigo_barras,
        Nombre: r.descripcion || ''
      }
    }));

  if (!items.length) return { skip: true, msg: 'No hay productos seleccionados en Monroe.' };

  const ref = referencia || `WEB-${Date.now()}`;
  const fecha = fechaEntrega || new Date().toISOString().slice(0, 10);

  const body = { referencia_cliente: ref, fecha_de_entrega: fecha, arrayProductos: items };

  try {
    // toma del cache (o relogin si expiró)
    const token = monroeTokenCache.get(sucursal)?.token
      || (await (async () => {
           // reutiliza la lógica del fetch (login si no hay token o expiró)
           const [credRows] = await db.query(`
             SELECT monroe_software_key, monroe_ecommerce_key, monroe_cuenta
             FROM credenciales_droguerias
             WHERE sucursal_codigo = ?
           `, [sucursal]);
           const { monroe_software_key, monroe_ecommerce_key, monroe_cuenta } = credRows[0];
           const loginRes = await axios.get('https://servicios.monroeamericana.com.ar/api-cli/Auth/login', {
             params: { software_key: monroe_software_key, token_duration: 300, ecommerce_customer_key: monroe_ecommerce_key, ecommerce_customer_reference: monroe_cuenta }
           });
           const t = loginRes.data.token ?? loginRes.data.access_token;
           monroeTokenCache.set(sucursal, { token: t, exp: Date.now() + MONROE_TOKEN_TTL_MS });
           return t;
         })());

    const url = 'https://servicios.monroeamericana.com.ar/api-cli/ade/1.0.0/crearPedido';

    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return { ok: true, resultado: resp.data, enviado: body };
  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error('❌ Error creando pedido en Monroe:', detalle);
    return { error: 'Fallo al crear el pedido en Monroe', detalle, enviado: body };
  }
}






// Cofarsur
async function fetchCofarsur(ean, sucursal) {
  try {
    const [credRows] = await db.query(`
      SELECT 
        cofarsur_usuario AS usuario,
        cofarsur_clave   AS clave,
        cofarsur_token   AS token
      FROM credenciales_droguerias
      WHERE sucursal_codigo = ?
    `, [sucursal]);
    if (!credRows.length) throw new Error('Credenciales Cofarsur no encontradas');
    const { usuario, clave, token } = credRows[0];

    // 1) Consultar existencia
    const existenciaXML = `
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soap:Header/>
  <soap:Body>
    <tem:ConsultarExistencia>
      <tem:DatosConsultarExistencia>
        <tem:usuario>${usuario}</tem:usuario>
        <tem:clave>${clave}</tem:clave>
        <tem:codigo_barra>${ean}</tem:codigo_barra>
        <tem:codigo_cofarsur>0</tem:codigo_cofarsur>
        <tem:codigo_alfabeta>0</tem:codigo_alfabeta>
        <tem:troquel>0</tem:troquel>
        <tem:token>${token}</tem:token>
      </tem:DatosConsultarExistencia>
    </tem:ConsultarExistencia>
  </soap:Body>
</soap:Envelope>`.trim();

    const existRes = await axios.post('http://www.cofarsur.net/ws', existenciaXML, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'http://tempuri.org/wsdl/ConsultarExistencia'
      },
      auth: { username: usuario, password: clave }
    });

    const existJson = await xml2js.parseStringPromise(existRes.data, {
      explicitArray: false,
      tagNameProcessors: [stripPrefix]
    });

    const bodyExist = existJson.Envelope?.Body || existJson.Body;
    const respExist =
      bodyExist?.ConsultarExistenciaResponse?.return ||
      bodyExist?.return ||
      existJson.return;

    // determinar stock
    let hasStock = null;
    if (respExist.estado != null) {
      const rawEstado = typeof respExist.estado === 'object' ? respExist.estado._ : respExist.estado;
      hasStock = (rawEstado === 'true' || rawEstado === true);
    } else if (respExist.stock != null) {
      const rawStock = typeof respExist.stock === 'object' ? respExist.stock._ : respExist.stock;
      hasStock = parseInt(rawStock, 10) === 1;
    }

    if (hasStock !== true) {
      return { stock: false, priceList: null, offerPrice: null, offers: [] };
    }

    // 2) Consultar precio
    const precioXML = `
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soap:Header/>
  <soap:Body>
    <tem:ConsultarPrecio>
      <tem:DatosConsultarPrecio>
        <tem:usuario>${usuario}</tem:usuario>
        <tem:clave>${clave}</tem:clave>
        <tem:codigo_barra>${ean}</tem:codigo_barra>
        <tem:codigo_cofarsur>0</tem:codigo_cofarsur>
        <tem:codigo_alfabeta>0</tem:codigo_alfabeta>
        <tem:troquel>0</tem:troquel>
        <tem:token>${token}</tem:token>
      </tem:DatosConsultarPrecio>
    </tem:ConsultarPrecio>
  </soap:Body>
</soap:Envelope>`.trim();

    const priceRes = await axios.post('http://www.cofarsur.net/ws', precioXML, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'http://tempuri.org/wsdl/ConsultarPrecio'
      },
      auth: { username: usuario, password: clave }
    });

    const priceJson = await xml2js.parseStringPromise(priceRes.data, {
      explicitArray: false,
      tagNameProcessors: [stripPrefix]
    });

    const bodyPrice = priceJson.Envelope?.Body || priceJson.Body;
    const respPrice =
      bodyPrice?.ConsultarPrecioResponse?.return ||
      bodyPrice?.return ||
      priceJson.return;

    // precio base y oferta
    const rawSin = respPrice?.costo_sin_iva?._ ?? respPrice?.costo_sin_iva;
    const rawOferta = respPrice?.costo_oferta_sin_iva?._ ?? respPrice?.costo_oferta_sin_iva;
    const mensaje = typeof respPrice?.mensaje === 'object' ? respPrice.mensaje._ : respPrice?.mensaje || '';

    const priceList = rawSin ? parseFloat(rawSin.replace(/,/g, '')) : null;
    let offerPrice = null;
    const offers = [];

    // si hay oferta numérica válida, usarla y armar descripción
    if (rawOferta) {
      const parsedOferta = parseFloat(rawOferta.replace(/,/g, ''));
      if (!isNaN(parsedOferta) && parsedOferta > 0) {
        offerPrice = parsedOferta;
        // extraer % desde descuento_oferta si está
        const rawPct = respPrice?.descuento_oferta?._ ?? respPrice?.descuento_oferta;
        const pct = rawPct ? parseFloat(rawPct.replace(/,/g, '')) : null;
        let desc = '';
        if (pct != null && !isNaN(pct)) desc += `${pct.toFixed(0)}%`;
        // mínimo extraer de mensaje: e.g. "minimo 2 unidades"
        const minMatch = mensaje.match(/minimo\s*(\d+)/i);
        if (minMatch) desc += ` min ${minMatch[1]} unidades`;
        if (!desc) desc = mensaje || 'Oferta';
        offers.push({ descripcion: desc.trim(), Condicion_Compra: { minimo_unids: minMatch ? parseInt(minMatch[1],10) : 1, maximo_unids: Infinity } });
      }
    }

    // si no se armó oferta válida, no hay offerPrice, queda priceList
    return {
      stock: true,
      priceList,
      offerPrice,
      offers
    };

  } catch (err) {
    console.error('fetchCofarsur error:', err.message);
    return { stock: null, priceList: null, offerPrice: null, offers: [] };
  }
}


// Crear pedido en Cofarsur
async function crearPedidoCofarsur(tabla, sucursal, {
  referencia = `WEB-${Date.now()}`, // no lo pide el servicio, pero lo dejamos por si querés loguear
  reparto = true,
} = {}) {
  try {
    // 1) Credenciales
    const [credRows] = await db.query(`
      SELECT 
        cofarsur_usuario AS usuario,
        cofarsur_clave   AS clave,
        cofarsur_token   AS token
      FROM credenciales_droguerias
      WHERE sucursal_codigo = ?
    `, [sucursal]);
    if (!credRows.length) throw new Error('Credenciales Cofarsur no encontradas');
    const { usuario, clave, token } = credRows[0];

    // 2) Items seleccionados en Cofarsur
    const items = tabla
      .filter(r => r.seleccionado === 'cofarsur')
      .map(r => ({
        codigo_barra: r.codigo_barras,
        troquel: 0,
        cantidad: Number(r.cantidad || 1)
      }));

    if (!items.length) return { skip: true, msg: 'No hay productos seleccionados en Cofarsur.' };

    // 3) Armar los <NS1:productosData> con ids y los <item href="#id">
    const productosNodes = items.map((it, idx) => `
      <NS1:productosData id="${idx + 2}" xsi:type="NS1:productosData">
        <codigo_barra xsi:type="xsd:string">${it.codigo_barra}</codigo_barra>
        <troquel xsi:type="xsd:int">${it.troquel}</troquel>
        <cantidad xsi:type="xsd:int">${it.cantidad}</cantidad>
      </NS1:productosData>
    `).join('');

    const itemsRefs = items.map((_, idx) => `
      <item href="#${idx + 2}"/>
    `).join('');

    // 4) Envelope RPC/encoded (como en Postman)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
  xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/">
  <SOAP-ENV:Body xmlns:NS1="urn:/ws" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <NS1:SolicitarPedido>
      <DatosSolicitarPedido href="#1"/>
    </NS1:SolicitarPedido>

    <NS1:DatosSolicitarPedido id="1" xsi:type="NS1:DatosSolicitarPedido">
      <usuario xsi:type="xsd:string">${usuario}</usuario>
      <clave xsi:type="xsd:string">${clave}</clave>
      <token xsi:type="xsd:string">${token}</token>
      <reparto xsi:type="xsd:boolean">${reparto ? 'true' : 'false'}</reparto>
      <productos xsi:type="SOAP-ENC:Array" SOAP-ENC:arrayType="NS1:productosData[${items.length}]">
        ${itemsRefs}
      </productos>
    </NS1:DatosSolicitarPedido>

    ${productosNodes}
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`.trim();

    console.log('📤 Cofarsur SolicitarPedido XML:', xml);

    // 5) POST
    const endpoint = 'http://www.cofarsur.net/ws';
    const resp = await axios.post(endpoint, xml, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://tempuri.org/wsdl/SolicitarPedido"' // igual a tu Postman
      },
      auth: { username: usuario, password: clave },
      timeout: 20000
    });

    console.log('📥 Cofarsur SolicitarPedido RAW:', resp.data);

    // 6) Parseo básico (si querés procesar más, lo ajustamos después)
    const parsed = await xml2js.parseStringPromise(resp.data, {
      explicitArray: false,
      tagNameProcessors: [stripPrefix]
    });
    const body = parsed.Envelope?.Body || parsed.Body;
    if (body?.Fault) {
      const msg = typeof body.Fault.faultstring === 'object'
        ? body.Fault.faultstring._
        : body.Fault.faultstring;
      return { error: 'Fault Cofarsur', detalle: msg };
    }

    // buscar respuesta típica:
    const respuesta = body?.SolicitarPedidoResponse
                   || body?.return
                   || body;
    return { ok: true, resultado: respuesta, enviado: { referencia, items } };

  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error('❌ Error SolicitarPedido Cofarsur:', detalle);
    return { error: 'Fallo al crear el pedido en Cofarsur', detalle };
  }
}




// fetchSuizo

async function fetchSuizo(ean, sucursal) {
  try {
    const [credRows] = await db.query(`
      SELECT 
        suizo_usuario AS usuario,
        suizo_clave   AS clave,
        suizo_cliente AS cliente
      FROM credenciales_droguerias
      WHERE sucursal_codigo = ?
    `, [sucursal]);
    if (!credRows.length) throw new Error('Credenciales Suizo no encontradas');
    const { usuario, clave, cliente } = credRows[0];

    console.log('🛠️ Suizo creds:', { usuario, cliente });

    const xmlRequest = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ws="http://tempuri.org/wspedidos2/">
  <soapenv:Header/>
  <soapenv:Body>
    <ws:Stock>
      <tcUsuario>${usuario}</tcUsuario>
      <tcClave>${clave}</tcClave>
      <tcTipo>2</tcTipo>
      <tcArticulos>${ean}</tcArticulos>
      <tcCliente>${cliente}</tcCliente>
    </ws:Stock>
  </soapenv:Body>
</soapenv:Envelope>`;

    console.log('📤 Suizo XML Request:', xmlRequest);

    const endpoint = 'https://ws.suizoargentina.com/webservice/wspedidos2.wsdl';
    const response = await axios.post(endpoint, xmlRequest, {
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': 'http://tempuri.org/wspedidos2/action/wspedidos2.Stock'
      }
    });

    console.log('📥 Suizo raw response:', response.data);

    const soapJson = await xml2js.parseStringPromise(response.data, {
      explicitArray: false,
      tagNameProcessors: [stripPrefix]
    });

    let innerXml = soapJson.Envelope
                         .Body
                         .StockResponse
                         .Result;

    console.log('🔎 Suizo <Result> content:', innerXml);

    // el Result viene como objeto con _ y $ a veces
    if (typeof innerXml === 'object' && innerXml._) innerXml = innerXml._;

    innerXml = innerXml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#13;/g, '\n');

    innerXml = innerXml.replace(/<xsd:schema[\s\S]*?<\/xsd:schema>/, '');
    const start = innerXml.indexOf('<VFPData');
    if (start !== -1) innerXml = innerXml.slice(start);

    console.log('📝 Suizo innerXml limpio:', innerXml.substring(0, 200), '…');

    const vfpJson = await xml2js.parseStringPromise(innerXml, {
      explicitArray: false,
      tagNameProcessors: [stripPrefix]
    });

    console.log('✅ Suizo VFPData JSON:', vfpJson);

    const rows = vfpJson.VFPData?.row;
    if (!rows) return { stock: null, priceList: null, offerPrice: null, offers: [] };
    const arr = Array.isArray(rows) ? rows : [rows];
    const item = arr.find(r => r.$.codbarra === ean);
    console.log('🔍 Suizo item encontrado:', item);
    if (!item) return { stock: null, priceList: null, offerPrice: null, offers: [] };

    const inStock = /^si$/i.test(item.$.stock);
    const priceList = parseFloat(item.$.precio) || null;

    // oferta viene en atributo `oferta`, por ejemplo: "FAR-20.00% Min.:1 -Dto.Cli"
    const offers = [];
    let offerPrice = null;
    if (item.$.oferta) {
      const m = item.$.oferta.match(/(\d+(\.\d+)?)%/);
      if (m) {
        const pct = parseFloat(m[1]);
        let leyenda = `${pct}%`;
        const minMatch = item.$.oferta.match(/Min\.?:\s*(\d+)/i);
        if (minMatch) leyenda += ` min ${minMatch[1]} unidades`;
        offers.push({ descripcion: leyenda, Condicion_Compra: { minimo_unids: minMatch ? parseInt(minMatch[1],10) : 1 } });
        if (typeof priceList === 'number') {
          offerPrice = priceList * (1 - pct / 100);
        }
      }
    }

    return {
      stock: inStock,
      priceList,
      offerPrice,
      offers
    };
  } catch (err) {
    console.error('fetchSuizo error:', err.message);
    return { stock: null, priceList: null, offerPrice: null, offers: [] };
  }
}



async function crearPedidoSuizo(
  tabla,
  sucursal,
  {
    empresa = 1,         // tnEmpresa
    formato = 1,         // tnFormato (1 = devuelve texto)
    tipo = 'CONFIRMA',   // tcTipo
    entrega = ''         // tcEntrega
  } = {}
) {
  try {
    // 1) Credenciales
    const [credRows] = await db.query(`
      SELECT 
        suizo_usuario AS usuario,
        suizo_clave   AS clave
      FROM credenciales_droguerias
      WHERE sucursal_codigo = ?
    `, [sucursal]);
    if (!credRows.length) throw new Error('Credenciales Suizo no encontradas');

    const { usuario, clave } = credRows[0];

    // 2) Items seleccionados en Suizo
    const items = tabla
      .filter(r => r.seleccionado === 'suizo')
      .map(r => ({
        cod_barra: r.codigo_barras,
        cantidad: String(r.cantidad || 1),
      }));

    if (!items.length) return { skip: true, msg: 'No hay productos seleccionados en Suizo.' };

    // 3) Construir el XML interno <pedidoid>…</pedidoid>
    const innerRows = items.map(it =>
      `<row><cod_barra>${it.cod_barra}</cod_barra><cantidad>${it.cantidad}</cantidad></row>`
    ).join('');

    const innerPedidoXML = `<pedidoid>${innerRows}</pedidoid>`;

    // 4) Escapar para mandarlo dentro de tcPedidoXML (muy importante)
    const xmlEscape = (s) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const tcPedidoXML = xmlEscape(innerPedidoXML);

    // 5) Envelope SOAP como en tu Postman
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://tempuri.org/wspedidos2/">
  <soapenv:Header/>
  <soapenv:Body>
    <ws:PedidoID>
      <tnEmpresa>${empresa}</tnEmpresa>
      <tcUsuario>${usuario}</tcUsuario>
      <tcClave>${clave}</tcClave>
      <tcPedidoXML>${tcPedidoXML}</tcPedidoXML>
      <tnFormato>${formato}</tnFormato>
      <tcTipo>${tipo}</tcTipo>
      <tcEntrega>${entrega}</tcEntrega>
    </ws:PedidoID>
  </soapenv:Body>
</soapenv:Envelope>`.trim();

    console.log('📤 Suizo PedidoID XML:', envelope);

    // 6) POST
    const url = 'https://ws.suizoargentina.com/webservice/wspedidos2.wsdl';
    const resp = await axios.post(url, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': '"http://tempuri.org/wspedidos2/PedidoID"'
      },
      timeout: 20000
    });

    console.log('📥 Suizo PedidoID RAW:', resp.data);

    // 7) Parseo básico
    const parsed = await xml2js.parseStringPromise(resp.data, {
      explicitArray: false,
      tagNameProcessors: [stripPrefix],
    });

    const body = parsed.Envelope?.Body || parsed.Body;
    if (body?.Fault) {
      const msg = typeof body.Fault.faultstring === 'object'
        ? body.Fault.faultstring._ : body.Fault.faultstring;
      return { error: 'Fault Suizo', detalle: msg };
    }

    // típicamente: Body.PedidoIDResponse.Result (o PedidoIDResult)
    const resultado = body?.PedidoIDResponse?.Result
                   || body?.PedidoIDResponse?.PedidoIDResult
                   || body;

    return { ok: true, resultado, enviado: { items } };

  } catch (err) {
    const detalle = err?.response?.data || err.message;
    console.error('❌ Error PedidoID Suizo:', detalle);
    return { error: 'Fallo al crear el pedido en Suizo', detalle };
  }
}







async function fetchKellerhof(ean, sucursal) { try { return { priceList:null, offerPrice:null }; } catch(e){return{priceList:null,offerPrice:null}} }

// controllers/pedidosController.js
// helper interno
function normalizePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/,/g, '').trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

exports.comparativa = async (req, res) => {
  console.log('🚀 comparativa invoked – carrito:', req.session.carrito);

  const carrito = req.session.carrito || [];
  const tabla = [];

  for (const item of carrito) {
    const { codigo_barras, descripcion, cantidad } = item;
    console.log(`🔄 Procesando EAN ${codigo_barras} (cantidad: ${cantidad}) para sucursal ${req.session.user.sucursal_codigo}`);

    const [
      quantioRaw,
      monroeRaw,
      cofarsurRaw,
      suizoRaw,
      kellerhofRaw
    ] = await Promise.all([
      fetchQuantio(codigo_barras, req.session.user.sucursal_codigo),
      fetchMonroe(codigo_barras, req.session.user.sucursal_codigo, cantidad),
      fetchCofarsur(codigo_barras, req.session.user.sucursal_codigo),
      fetchSuizo(codigo_barras, req.session.user.sucursal_codigo),
      fetchKellerhof(codigo_barras, req.session.user.sucursal_codigo)
    ]);

    // Normalizamos / homogeneizamos shapes
    const quantio = {
      stock: !!(quantioRaw && quantioRaw.stock),
      idproducto: quantioRaw?.idproducto
    };

    const monroe = {
  stock: monroeRaw?.stock === true,
  priceList: normalizePrice(monroeRaw?.priceList),
  offerPrice: normalizePrice(monroeRaw?.offerPrice),
  offers: Array.isArray(monroeRaw?.offers) ? monroeRaw.offers : [],
  token: monroeRaw?.token || null   // 👈 guardar token por si querés usarlo directo
};

   const cofarsur = {
  stock: cofarsurRaw?.stock === true,
  priceList: normalizePrice(cofarsurRaw?.priceList),
  offerPrice: normalizePrice(cofarsurRaw?.offerPrice),
  offers: Array.isArray(cofarsurRaw?.offers) ? cofarsurRaw.offers : (cofarsurRaw?.offers ? [cofarsurRaw.offers] : [])
};

    const suizo = {
      stock: suizoRaw?.stock === true,
      priceList: normalizePrice(suizoRaw?.priceList),
      offerPrice: normalizePrice(suizoRaw?.offerPrice)
    };

    const kellerhof = {
      stock: kellerhofRaw?.stock === true,
      priceList: normalizePrice(kellerhofRaw?.priceList),
      offerPrice: normalizePrice(kellerhofRaw?.offerPrice)
    };

    // Construir candidaturas y decidir seleccionado
    let seleccionado = null;

    if (quantio.stock) {
      seleccionado = 'quantio';
    } else {
      const candidatos = [
        { name: 'monroe',    data: monroe },
        { name: 'cofarsur',  data: cofarsur },
        { name: 'suizo',     data: suizo },
        { name: 'kellerhof', data: kellerhof }
      ].map(c => {
        const effective = c.data.offerPrice != null ? c.data.offerPrice : c.data.priceList;
        return {
          name: c.name,
          price: typeof effective === 'number' ? effective : null
        };
      }).filter(c => c.price != null);

      console.log('Comparativa precios candidatos:', candidatos);

      if (candidatos.length) {
        candidatos.sort((a, b) => a.price - b.price);
        seleccionado = candidatos[0].name;
      }
    }

    // empujás cada fila dentro del for...
tabla.push({
  codigo_barras,
  descripcion,
  cantidad,
  quantio,
  monroe,
  cofarsur,
  suizo,
  kellerhof,
  seleccionado
});
} // <- cierre del for

// POST: inyectar selección y disparar pedido a Quantio
if (req.method === 'POST') {
  // Actualizar selección desde el form
  tabla.forEach((row, i) => {
    row.seleccionado = req.body[`seleccion_${i}`] || row.seleccionado;
  });

  // --- Quantio: solo si hay Q seleccionados ---
  const hayQuantio = tabla.some(r => r.seleccionado === 'quantio');
  if (hayQuantio) {
    const resQ = await crearPedidoQuantio(tabla, req.session.user?.sucursal_codigo);
    if (resQ?.error) {
      console.warn('Error en pedido Quantio:', resQ);
      res.locals.errorQuantio = resQ;
    } else {
      console.log('Pedido Quantio OK:', resQ.resultado);
      res.locals.successQuantio = resQ.resultado;
    }
  }

  // --- Monroe: solo si hay M seleccionados ---
  const hayMonroe = tabla.some(r => r.seleccionado === 'monroe');
  if (hayMonroe) {
    const resM = await crearPedidoMonroe(
      tabla,
      req.session.user?.sucursal_codigo,
      { referencia: `WEB-${Date.now()}` } // opcional fechaEntrega
    );
    if (resM?.error) {
      console.warn('Error en pedido Monroe:', resM);
      res.locals.errorMonroe = resM;
    } else if (!resM?.skip) {
      console.log('Pedido Monroe OK:', resM.resultado);
      res.locals.successMonroe = resM.resultado;
    }
  }
}

// --- Cofarsur: solo si hay seleccionados en C ---
const hayC = tabla.some(r => r.seleccionado === 'cofarsur');
if (hayC) {
  const resC = await crearPedidoCofarsur(
    tabla,
    req.session.user?.sucursal_codigo,
    { reparto: true } // o false, según tu caso
  );
  if (resC?.error) {
    console.warn('Error en pedido Cofarsur:', resC);
    res.locals.errorCofarsur = resC;
  } else if (!resC?.skip) {
    console.log('Pedido Cofarsur OK:', resC.resultado);
    res.locals.successCofarsur = resC.resultado;
  }
}


// --- Suizo: solo si hay seleccionados en S ---
const haySuizo = tabla.some(r => r.seleccionado === 'suizo');
if (haySuizo) {
  const resSuizo = await crearPedidoSuizo(
    tabla,
    req.session.user?.sucursal_codigo,
    {
      empresa: 1,
      formato: 1,
      tipo: 'CONFIRMA',   // o 'RESERVA' si quisieras reservar primero
      entrega: ''         // si tenés un código/observación de entrega, ponelo acá
    }
  );
  if (resSuizo?.error) {
    console.warn('Error en pedido Suizo:', resSuizo);
    res.locals.errorSuizo = resSuizo;
  } else if (!resSuizo?.skip) {
    console.log('Pedido Suizo OK:', resSuizo.resultado);
    res.locals.successSuizo = resSuizo.resultado;
  }
}
res.render('comparativa', { tabla });

};
module.exports.crearPedidoQuantio = crearPedidoQuantio;