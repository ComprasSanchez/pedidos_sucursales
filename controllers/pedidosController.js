// controllers/pedidosController.js
const axios = require('axios');
const xml2js = require('xml2js');
const { stripPrefix } = require('xml2js').processors;
const { db, plex } = require('../db');


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

    return { stock: hasStock };
  }
  catch (err) {
    if (err.response) {
      console.error('❌ Quantio HTTP:', err.response.status, err.response.data);
    }
    console.error('Quantio error:', err.message);
    return { stock: false };
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

    const token = loginRes.data.token ?? loginRes.data.access_token;
    if (!token) {
      console.error('❌ Monroe Login Response completo:', JSON.stringify(loginRes.data, null, 2));
      throw new Error('Token Monroe vacío');
    }

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
      return { stock: false, priceList: null, offerPrice: null, offers: [] };
    }

    const priceList = prod.Precio.lista;
    const rawOffers = Array.isArray(prod.arrayOfertas) ? prod.arrayOfertas : [];
    const offers = [];

    // filtrar por cantidad y armar leyendas
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

    return {
      stock: true,
      priceList,
      offerPrice,
      offers
    };
  } catch (err) {
    console.error('Monroe error:', err.message);
    return { stock: null, priceList: null, offerPrice: null, offers: [] };
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





// controllers/pedidosController.js

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
      stock: !!(quantioRaw && quantioRaw.stock)
    };

    const monroe = {
      stock: monroeRaw?.stock === true,
      priceList: normalizePrice(monroeRaw?.priceList),
      offerPrice: normalizePrice(monroeRaw?.offerPrice),
      offers: Array.isArray(monroeRaw?.offers) ? monroeRaw.offers : []
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
  }

  res.render('comparativa', { tabla });
};
