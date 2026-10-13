/**
 * ============================================================================
 *  REPORTE DE STOCK Y ROTACIÓN — Vitalica
 * ============================================================================
 *
 *  Adaptado del reporte de Camping 44. Mismo Odoo, mismo tenant, mismas
 *  propiedades del script; cambia lo que Vitalica tiene distinto:
 *
 *  · VALORIZACIÓN. Los productos de Vitalica tienen el costo de la ficha en
 *    cero, así que cantidad × costo da Gs. 0. Se valoriza con el valor de
 *    stock.quant, configurable en STK.VALORIZAR_CON.
 *  · SIN MARCAS. product_brand_id está vacío en todo el catálogo: el eje del
 *    reporte es la FAMILIA (la categoría de producto de Odoo).
 *  · SIN MATERIAL CONTROLADO. Quedan A, B, C, N y Sin categorizar.
 *  · EL DEPÓSITO ES EL EJE PRINCIPAL. La mayoría de los depósitos son
 *    gimnasios: el reporte abre stock y rotación por cada uno.
 *
 *  Todo lleva prefijo stk. Los archivos de un proyecto de Apps Script
 *  comparten un único espacio de nombres: dos funciones con el mismo nombre se
 *  pisan en silencio. Si agregás algo, seguí la misma regla.
 *
 *  QUÉ NO HACE
 *  · No escribe en Odoo. Solo search_read, read, search y search_count.
 *  · No toca menús, disparadores ni propiedades ajenas.
 *
 *  ----------------------------------------------------------------------
 *  PUESTA EN MARCHA
 *
 *  1. Planilla nueva en Drive, por ejemplo "Rotación ABC Vitalica".
 *
 *  2. Extensiones → Apps Script. Borrar el código de ejemplo y pegar esto.
 *
 *  3. Configuración del proyecto → Propiedades del script:
 *
 *        ODOO_URL       https://loquesea.odoo.com     (sin barra final)
 *        ODOO_DB        nombre de la base
 *        ODOO_LOGIN     tu correo de Odoo
 *        ODOO_API_KEY   clave API propia (Mi perfil → Seguridad de la cuenta)
 *        GITHUB_TOKEN   token con permiso de escritura sobre el repo
 *        STK_AVISAR_A   (opcional) correo para avisar si falla la corrida
 *
 *     El token de GitHub va acá, nunca en el código.
 *
 *  4. Ejecutar stkInstalarMenu() una vez y recargar la planilla.
 *
 *  ORDEN DE USO
 *      1. Diagnosticar Odoo     conexión, empresa, campos, costos y depósitos
 *      2. Detectar marcas       confirma que no hay marcas cargadas
 *         Detectar desvíos      revisa que el valor de stock.quant sea confiable
 *      3. Actualizar y publicar extrae, escribe las hojas y sube datos.js
 * ============================================================================
 */

/** Instala el menú propio. */
function stkInstalarMenu() {
  const id = stkSS_().getId();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'stkMenu') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('stkMenu').forSpreadsheet(id).onOpen().create();
  stkAvisar_('Menú instalado', 'Recargá la planilla y va a aparecer el menú "Reporte de Stock".');
}


const STK = Object.freeze({
  ZONA_HORARIA: 'America/Asuncion',

  /* Empresa del reporte, tal como figura en Odoo (búsqueda parcial). */
  EMPRESA: 'VITALICA',

  /* Procedimiento que respalda la clasificación ABC, si lo hay. Se muestra en
     el encabezado del reporte. El MP-MIS-01 es de Camping 44: hasta confirmar
     si aplica a Vitalica o si tiene uno propio, queda vacío y no se muestra. */
  NORMA: '',

  /* VALORIZACIÓN
     ------------------------------------------------------------------
     'quant'  el valor de stock.quant: el valor contable de cada existencia,
              que sale de las capas de valorización. Es lo único que hay en
              Vitalica, porque el costo de la ficha está en cero.
     'costo'  cantidad × costo de la ficha (standard_price). Es el criterio de
              Camping 44, donde stock.quant arrastra un ajuste mal revertido.
              Conviene volver a este el día que se carguen costos en Vitalica.

     Si el usuario API no puede leer el valor de stock.quant, se cae a 'costo'
     y se avisa al terminar la corrida. */
  VALORIZAR_CON: 'quant',

  /* Campo de rotación ABC en product.template. Hay otro casi igual,
     x_studio_categoria_de_rotacin (sin la o), que es un espejo de solo lectura
     de la variante: no usar ese. */
  CAMPO_ABC: 'x_studio_categoria_de_rotacion',

  /* Campo de marca de Odoo. En Vitalica está vacío; solo se usa para
     confirmarlo desde "2. Detectar marcas". */
  CAMPO_MARCA: 'product_brand_id',

  /* Tope del histórico. Si Odoo tiene capas desde hace menos tiempo, el
     gráfico arranca en el primer mes con datos y crece solo hasta este tope. */
  MESES_HISTORICO: 18,
  MESES_ROTACION: 6,
  /* Topes del archivo publicado. Vitalica tiene un orden de magnitud menos de
     productos que Camping 44: sobran holgadamente. */
  TOP_ARTICULOS: 5000,
  TOP_SERIES_ARTICULO: 1000,
  LOTE_API: 1000,

  /* Publicación. */
  GITHUB_OWNER: 'TI-Camping44',
  GITHUB_REPO: 'ROTACION-ABC-VITALICA',
  GITHUB_RAMA: 'main',
  GITHUB_ARCHIVO: 'datos.js',

  /* DEPÓSITOS
     ------------------------------------------------------------------
     Cada almacén de Odoo se agrupa por su código corto (el "code" del
     almacén). Lo que no figure acá cae en GRUPO_DEFECTO. El orden de la lista
     es el orden en que aparecen los grupos en el reporte. */
  GRUPOS_DEPOSITO: Object.freeze([
    { grupo: 'Propios',        codigos: ['VI-CC', 'MGLOG', 'VI-SH', 'VI-EX'] },
    { grupo: 'Gimnasios RM',   codigos: ['RMLAM'] },
    { grupo: 'Gimnasios BIGG', codigos: ['BLPER', 'BCENT', 'BSEIF', 'BHERR'] },
    { grupo: 'Gimnasios GTC',  codigos: ['GTFZS', 'GTACN', 'GTCGR', 'GTFDM', 'GTLAM',
                                         'GTLOM', 'GTLUQ', 'GTMCA', 'GTCVE'] },
  ]),
  GRUPO_DEFECTO: 'Otros',
  /* Grupo de las ubicaciones no comerciales que no cuelgan de ningún almacén
     con grupo (en Vitalica, Exhibición y Marketing están sueltas). */
  GRUPO_NO_COMERCIAL: 'No comerciales',

  /* Depósitos que son MUESTRARIO: el kit de exhibición que Vitalica deja en
     cada gimnasio. Es stock propio y suma al total, pero no se vende desde
     ahí (las ventas salen de Casa Central), así que no lleva estado de
     reposición ni cuenta como "parado". Se compara contra el código o el
     nombre del almacén, sin acentos ni mayúsculas. */
  DEPOSITOS_MUESTRARIO: Object.freeze([
    'RMLAM',
    'BLPER', 'BCENT', 'BSEIF', 'BHERR',
    'GTFZS', 'GTACN', 'GTCGR', 'GTFDM', 'GTLAM', 'GTLOM', 'GTLUQ', 'GTMCA', 'GTCVE',
  ]),

  /* Depósitos de ABASTECIMIENTO: guardan la reserva que repone a los que
     venden, y no venden directo. Su cobertura se mide contra la venta de
     toda la empresa, no contra la propia, que es cero. */
  DEPOSITOS_ABASTECIMIENTO: Object.freeze(['MGLOG']),

  /* Depósitos o ubicaciones cuyo stock existe pero NO se vende: exhibición y
     material de marketing. Se compara contra cada tramo de la ruta de la
     ubicación (sin acentos ni mayúsculas, por coincidencia parcial). Si la
     ubicación está dentro de un almacén vendible, se separa como depósito
     propio para que su stock no se mezcle con el del almacén.
     Ojo: "Showroom" solo no sirve, porque también es el nombre del almacén
     VI-SH, que sí vende. En Odoo la ubicación es "Exhibición Vitalica Showroom". */
  DEPOSITOS_NO_COMERCIALES: Object.freeze(['Exhibición', 'Marketing']),

  /* Umbrales de cobertura, en meses de venta, para el estado de cada artículo
     en cada depósito:
       por debajo de MINIMA  → reponer
       por encima de MAXIMA  → exceso
     Un artículo con stock y sin ventas en la ventana queda "parado". */
  COBERTURA_MINIMA: 1,
  COBERTURA_MAXIMA: 6,

  /* CANAL DE VENTA
     Primero manda el equipo de ventas del pedido; si el pedido no tiene equipo,
     se deduce de la lista de precios del cliente. Las claves se comparan contra
     el ARRANQUE del nombre de la lista, ya normalizado (sin espacios, tildes ni
     signos): "Retail 1" es RETAIL1 y "DIST1 USD" es DIST1USD.

     MAPEO PROVISORIO, pendiente de Gerencia. Las listas en dólares no cambian
     nada del cálculo: el costo de venta sale de las capas de valorización, que
     están en guaraníes; la lista solo dice a qué canal pertenece el cliente. */
  CANAL_DEFECTO: 'Sin canal',
  CANALES_POR_EQUIPO: Object.freeze({}),
  CANALES_POR_LISTA: Object.freeze([
    { canal: 'Consumidor final', claves: ['PUBLICO', 'RETAIL', 'PROMO'] },
    { canal: 'Embajadores',      claves: ['EMBAJADOR'] },
    { canal: 'Distribución',     claves: ['DIST', 'CONGS'] },
    { canal: 'Exterior',         claves: ['EXT'] },
  ]),

  /* FAMILIAS UNIFICADAS
     La familia es la última hoja del árbol de categorías. Cuando una misma
     familia está repartida en varias categorías de Odoo, se junta acá.
     Cada categoría se escribe como el final de su ruta, con " / " entre
     tramos: "Proteína / VITALICA" coincide con ALL / Proteína / VITALICA y no
     con cualquier otra categoría que se llame VITALICA. */
  FAMILIAS_UNIFICADAS: Object.freeze([
    { familia: 'Proteínas', categorias: ['Suplementos (Padre) / Proteínas', 'Proteína', 'Proteína / VITALICA'] },
  ]),

  /* Productos que quedan fuera del reporte, por referencia interna. */
  PRODUCTOS_EXCLUIDOS: Object.freeze([]),

  /* Categorías que no son mercadería para la venta. Se comparan contra la
     última hoja del árbol. Las de Camping 44 (NO USAR, Ajustes, Recupero...)
     probablemente no existan acá; dejarlas no hace daño. Revisar con
     "1b. Revisar qué queda afuera". */
  CATEGORIAS_EXCLUIDAS: Object.freeze([
    'NO USAR', 'Ajustes', 'Descuento', 'Anticipo de Cliente',
    'Gastos de Importación (Landed Cost)', 'Intereses', 'Servicios',
    /* Del árbol de Vitalica: categorías contables, no mercadería. */
    'DESCUENTOS COMERCIALES', 'Expenses', 'Impuestos no capitalizables', 'IVA Despacho',
  ]),

  HOJAS: Object.freeze({
    STOCK: 'STOCK', ARTICULOS: 'ARTICULOS', DEPOSITOS: 'DEPOSITOS',
    HISTORICO: 'HISTORICO', ROTACION: 'ROTACION', BITACORA: 'BITACORA',
    MARCAS: 'MARCAS', DIAGNOSTICO: 'DIAGNOSTICO',
  }),
});


function stkMenu() {
  let ui;
  try { ui = SpreadsheetApp.getUi(); }
  catch (sinInterfaz) {
    Logger.log('stkMenu solo se puede ejecutar con la planilla abierta. Ejecutá stkInstalarMenu() y recargá.');
    return;
  }
  ui.createMenu('Reporte de Stock')
    .addItem('1. Diagnosticar Odoo', 'stkDiagnosticar')
    .addItem('1b. Revisar qué queda afuera', 'stkRevisarExcluidas')
    .addItem('1c. Ver campos personalizados', 'stkCamposPersonalizados')
    .addItem('1d. Ver etiquetas de producto', 'stkEtiquetas')
    .addItem('Auditar un producto', 'stkAuditarProducto')
    .addItem('Detectar desvíos de valorización', 'stkDesvios')
    .addItem('Ver bitácora de cambios', 'stkVerBitacora')
    .addItem('2. Detectar marcas', 'stkDetectarMarcas')
    .addItem('3. Actualizar y publicar', 'stkAutomatico')
    .addSeparator()
    .addItem('Solo actualizar las hojas', 'stkActualizarDatos')
    .addItem('Programar actualización diaria', 'stkProgramar')
    .addItem('Cancelar actualización diaria', 'stkCancelarProgramacion')
    .addItem('Ver estado de la programación', 'stkEstadoProgramacion')
    .addToUi();
}


/* ==========================================================================
   CONEXIÓN CON ODOO — solo lectura
   ========================================================================== */

function stkSesion_() {
  const props = PropertiesService.getScriptProperties();
  const faltan = ['ODOO_URL', 'ODOO_DB', 'ODOO_LOGIN', 'ODOO_API_KEY']
    .filter(p => !props.getProperty(p));
  if (faltan.length) {
    throw new Error(
      `Faltan propiedades del script: ${faltan.join(', ')}.\n` +
      'Configuración del proyecto → Propiedades del script.'
    );
  }
  /* Solo el dominio. Es fácil pegar la dirección del navegador
     (".../odoo/inventory", ".../web#action=...") y el script terminaba
     pidiendo ".../odoo/inventory/jsonrpc", que Odoo contesta con un 404. */
  const crudo = String(props.getProperty('ODOO_URL')).trim();
  const conEsquema = /^https?:\/\//i.test(crudo) ? crudo : 'https://' + crudo;
  const dominio = conEsquema.match(/^https?:\/\/[^\/?#\s]+/i);
  if (!dominio) {
    throw new Error(`ODOO_URL no parece una dirección: "${crudo}". Tiene que ser como https://algo.odoo.com`);
  }
  const url = dominio[0];
  const db = props.getProperty('ODOO_DB');
  const login = props.getProperty('ODOO_LOGIN');
  const clave = props.getProperty('ODOO_API_KEY');

  const uid = stkRpc_(url, 'common', 'authenticate', [db, login, clave, {}]);
  if (!uid) throw new Error('Odoo rechazó la autenticación. Revisá URL, base, usuario y clave API.');

  return { url, db, uid, clave, companyIds: [] };
}

function stkRpc_(url, service, method, args) {
  const r = UrlFetchApp.fetch(`${url}/jsonrpc`, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { service, method, args },
    }),
  });
  const codigo = r.getResponseCode();
  const texto = r.getContentText();
  if (codigo < 200 || codigo >= 300) throw new Error(`HTTP ${codigo} desde Odoo: ${texto.substring(0, 600)}`);
  let cuerpo;
  try { cuerpo = JSON.parse(texto); }
  catch (e) { throw new Error(`Odoo no devolvió JSON: ${texto.substring(0, 600)}`); }
  if (cuerpo.error) {
    const d = cuerpo.error.data || {};
    throw new Error(d.message || cuerpo.error.message || 'Error RPC de Odoo');
  }
  return cuerpo.result;
}

function stkEjecutar_(sesion, modelo, metodo, args, kwargs) {
  const kw = Object.assign({}, kwargs || {});
  const ctx = Object.assign({}, kw.context || {});
  if (sesion.companyIds.length && !ctx.allowed_company_ids) ctx.allowed_company_ids = sesion.companyIds;
  kw.context = ctx;
  const r = stkRpc_(sesion.url, 'object', 'execute_kw',
    [sesion.db, sesion.uid, sesion.clave, modelo, metodo, args || [], kw]);
  /* Odoo puede contestar sin "result". Sin esto el undefined viaja y revienta
     mucho más adelante con un "Cannot read properties of undefined", que no
     dice ni el modelo ni el método. */
  if (r === undefined || r === null) {
    throw new Error(`Odoo no devolvió datos para ${modelo}.${metodo}.`);
  }
  return r;
}

function stkLeerTodo_(sesion, modelo, dominio, campos, orden, contexto) {
  const salida = [];
  let desplazamiento = 0;
  for (;;) {
    const lote = stkEjecutar_(sesion, modelo, 'search_read', [dominio], {
      fields: campos, offset: desplazamiento, limit: STK.LOTE_API, order: orden || 'id asc',
      context: contexto || undefined,
    });
    salida.push(...lote);
    if (lote.length < STK.LOTE_API) break;
    desplazamiento += lote.length;
  }
  return salida;
}

function stkCamposDe_(sesion, modelo) { return stkEjecutar_(sesion, modelo, 'fields_get', [], {}); }

function stkCamposQueExisten_(meta, deseados) {
  return deseados.filter(c => Object.prototype.hasOwnProperty.call(meta, c));
}

function stkEmpresa_(sesion) {
  const clave = stkNorm_(STK.EMPRESA);
  const empresas = stkLeerTodo_(sesion, 'res.company', [['active', '=', true]], ['id', 'name'], 'id asc');
  const encontrada = empresas.filter(e => stkNorm_(e.name).includes(clave))[0];
  if (!encontrada) {
    throw new Error(`No se encontró "${STK.EMPRESA}". Disponibles: ${empresas.map(e => e.name).join(', ')}`);
  }
  return encontrada;
}

/** Sesión abierta y fijada en la empresa del reporte. */
function stkConectar_() {
  const sesion = stkSesion_();
  const empresa = stkEmpresa_(sesion);
  sesion.companyIds = [empresa.id];
  return { sesion, empresa };
}

/** Plantillas almacenables activas de la empresa, con los campos pedidos. */
function stkPlantillas_(sesion, empresa, meta, campos) {
  const campoTipo = meta.detailed_type ? 'detailed_type' : 'type';
  return stkLeerTodo_(sesion, 'product.template', [
    ['active', '=', true],
    [campoTipo, '=', 'product'],
    '|', ['company_id', '=', false], ['company_id', '=', empresa.id],
  ], stkCamposQueExisten_(meta, campos), 'id asc');
}

/** variante -> plantilla. El stock vive en las variantes, no en la plantilla. */
function stkVariantes_(sesion, idsPlantilla) {
  const plantillaPorVariante = {};
  stkLotes_(idsPlantilla, STK.LOTE_API).forEach(lote => {
    stkLeerTodo_(sesion, 'product.product', [['product_tmpl_id', 'in', lote]],
      ['id', 'product_tmpl_id'], 'id asc')
      .forEach(v => { plantillaPorVariante[v.id] = stkId_(v.product_tmpl_id); });
  });
  return plantillaPorVariante;
}


/* ==========================================================================
   VALORIZACIÓN
   ==========================================================================
   Un solo lugar decide cómo se valoriza una existencia, para que el reporte,
   los diagnósticos y la auditoría no den números distintos entre sí.
   ========================================================================== */

/** 'quant' o 'costo', según STK.VALORIZAR_CON y lo que el usuario API puede leer. */
function stkModoValor_(metaQuant) {
  const quiere = STK.VALORIZAR_CON === 'costo' ? 'costo' : 'quant';
  if (quiere === 'quant' && !metaQuant.value) return 'costo';
  return quiere;
}

function stkMonto_(modo, cantidad, valorQuant, costo) {
  return modo === 'quant' ? stkNum_(valorQuant) : cantidad * stkNum_(costo);
}

function stkNombreModo_(modo) {
  return modo === 'quant'
    ? 'valor contable de stock.quant'
    : 'cantidad × costo de la ficha';
}

/**
 * Cantidad y valor de stock por plantilla, en depósitos internos.
 * Para los diagnósticos: el reporte arma lo suyo en stkStock_, con depósito.
 */
function stkValorPorPlantilla_(sesion, empresa, costoPorPlantilla, plantillaPorVariante) {
  const metaQuant = stkCamposDe_(sesion, 'stock.quant');
  const modo = stkModoValor_(metaQuant);
  const valor = {}, cantidad = {};
  stkLeerTodo_(sesion, 'stock.quant', [
    ['company_id', '=', empresa.id],
    ['location_id.usage', '=', 'internal'],
  ], stkCamposQueExisten_(metaQuant, ['id', 'product_id', 'quantity', 'value']), 'id asc')
    .forEach(q => {
      const t = plantillaPorVariante[stkId_(q.product_id)];
      if (!t) return;
      const cant = stkNum_(q.quantity);
      cantidad[t] = (cantidad[t] || 0) + cant;
      valor[t] = (valor[t] || 0) + stkMonto_(modo, cant, q.value, costoPorPlantilla[t]);
    });
  return { valor, cantidad, modo };
}


/* ==========================================================================
   1. DIAGNÓSTICO
   ==========================================================================
   Antes de extraer nada: ¿conecta, encuentra la empresa, existen los campos,
   hay capas de valorización, el costo de la ficha está cargado, y los
   depósitos de Odoo coinciden con los códigos configurados?
   ========================================================================== */

function stkDiagnosticar() {
  const { sesion, empresa } = stkConectar_();

  const metaCapa = stkCamposDe_(sesion, 'stock.valuation.layer');
  const campoFecha = metaCapa.create_date ? 'create_date' : 'date';
  const capas = stkEjecutar_(sesion, 'stock.valuation.layer', 'search_count',
    [[['company_id', '=', empresa.id]]], {});

  let primeraCapa = '';
  if (capas) {
    const p = stkEjecutar_(sesion, 'stock.valuation.layer', 'search_read',
      [[['company_id', '=', empresa.id]]], { fields: [campoFecha], limit: 1, order: `${campoFecha} asc` });
    primeraCapa = p.length ? String(p[0][campoFecha]).substring(0, 10) : '';
  }

  const categorias = stkLeerTodo_(sesion, 'product.category', [],
    ['id', 'complete_name', 'name', 'property_cost_method', 'property_valuation'], 'id asc');
  const automaticas = categorias.filter(c => c.property_valuation === 'real_time').length;
  const metodos = Array.from(new Set(categorias.map(c => c.property_cost_method || 'sin definir')));

  const detalle = categorias
    .map(c => {
      const ruta = c.complete_name || c.name;
      return [
        ruta,
        c.property_cost_method || 'sin definir',
        c.property_valuation === 'real_time' ? 'automática' : 'MANUAL',
        stkExcluida_(ruta) ? 'excluida del reporte' : stkFamilia_(ruta),
      ];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es'));
  stkEscribir_('DIAGNOSTICO CATEGORIAS',
    ['Categoría', 'Método de costo', 'Valoración', 'Familia en el reporte'],
    detalle, []);

  const metaProd = stkCamposDe_(sesion, 'product.template');
  const metaQuant = stkCamposDe_(sesion, 'stock.quant');

  /* Costo de la ficha y categoría ABC, producto por producto. standard_price
     depende de la empresa: se lee con Vitalica fijada en el contexto. */
  const plantillas = stkPlantillas_(sesion, empresa, metaProd,
    ['id', 'standard_price', STK.CAMPO_ABC, STK.CAMPO_MARCA]);
  const conCosto = plantillas.filter(t => stkNum_(t.standard_price) > 0).length;
  const conMarca = metaProd[STK.CAMPO_MARCA]
    ? plantillas.filter(t => Boolean(t[STK.CAMPO_MARCA])).length : 0;
  const porLetra = {};
  plantillas.forEach(t => {
    const v = stkVisible_(metaProd[STK.CAMPO_ABC], t[STK.CAMPO_ABC]) || '(vacío)';
    porLetra[v] = (porLetra[v] || 0) + 1;
  });
  const letras = Object.keys(porLetra).sort((a, b) => porLetra[b] - porLetra[a])
    .map(k => `${k}: ${porLetra[k]}`).join(' · ');
  const conLetra = plantillas.filter(t =>
    ['A', 'B', 'C'].indexOf(stkNorm_(stkVisible_(metaProd[STK.CAMPO_ABC], t[STK.CAMPO_ABC]))) >= 0).length;

  const modo = stkModoValor_(metaQuant);
  const depositos = stkDiagnosticoDepositos_(sesion, empresa);

  const filas = [
    ['Empresa', `${empresa.name} [${empresa.id}]`],
    ['', ''],
    ['Capas de valorización', capas],
    ['Capa más antigua', primeraCapa || 'ninguna'],
    ['¿Hay histórico posible?', capas > 0 ? `SÍ, desde ${primeraCapa}` : 'NO — la Parte 2 del reporte no se puede hacer'],
    ['', ''],
    ['Categorías de producto', categorias.length],
    ['Con valoración automática', automaticas],
    ['Métodos de costo en uso', metodos.join(', ')],
    ['', ''],
    ['Productos almacenables', plantillas.length],
    ['Con costo cargado en la ficha', `${conCosto} de ${plantillas.length}`],
    ['Valor en stock.quant', metaQuant.value ? 'visible' : 'SIN PERMISO'],
    ['Valorización configurada', `${STK.VALORIZAR_CON} → se usa ${stkNombreModo_(modo)}`],
    ['Lectura',
      modo === 'costo' && conCosto === 0
        ? 'ATENCIÓN: se valoriza con el costo de la ficha y está en cero. El reporte va a dar Gs. 0.'
        : modo === 'quant' && conCosto === plantillas.length && plantillas.length
          ? 'Todos los productos tienen costo: se puede evaluar volver a VALORIZAR_CON = costo.'
          : 'OK'],
    ['', ''],
    [`Campo ABC (${STK.CAMPO_ABC})`, metaProd[STK.CAMPO_ABC] ? 'existe' : 'NO EXISTE'],
    ['Categorías de rotación cargadas', letras],
    ['Cobertura A/B/C', `${conLetra} de ${plantillas.length} productos`],
    [`Campo marca (${STK.CAMPO_MARCA})`,
      metaProd[STK.CAMPO_MARCA]
        ? `existe · ${conMarca} productos con marca — el reporte se arma por familia`
        : 'no existe — el reporte se arma por familia'],
    ['', ''],
    ['Almacenes en Odoo', depositos.almacenes],
    ['Códigos configurados que no aparecen en Odoo', depositos.faltan.join(', ') || 'ninguno'],
    ['Almacenes sin grupo (caen en "' + STK.GRUPO_DEFECTO + '")', depositos.sinGrupo.join(', ') || 'ninguno'],
    ['Ubicaciones no comerciales detectadas', depositos.noComerciales.join(' · ') || 'NINGUNA — revisar DEPOSITOS_NO_COMERCIALES'],
    ['', ''],
    ['Excluidas del reporte', detalle.filter(d => d[3] === 'excluida del reporte').map(d => d[0]).join(' · ') || 'ninguna'],
    ['', ''],
    ['Diagnóstico ejecutado', stkAhora_()],
  ];
  stkEscribir_(STK.HOJAS.DIAGNOSTICO, ['Punto', 'Resultado'], filas, []);
  stkSS_().setActiveSheet(stkHoja_(STK.HOJAS.DIAGNOSTICO));

  stkAvisar_('Diagnóstico', [
    `Empresa: ${empresa.name}`,
    `Capas de valorización: ${capas}` + (capas > 0 ? ` (desde ${primeraCapa})` : ' — sin histórico posible'),
    `Productos con costo en la ficha: ${conCosto} de ${plantillas.length}`,
    `Se valoriza con: ${stkNombreModo_(modo)}`,
    `Almacenes: ${depositos.almacenes}` +
      (depositos.faltan.length ? ` · ${depositos.faltan.length} códigos configurados no aparecen` : ''),
    '',
    'El detalle quedó en las hojas DIAGNOSTICO, DIAGNOSTICO CATEGORIAS y DIAGNOSTICO DEPOSITOS.',
  ].join('\n'));
}

/** Cruza los almacenes de Odoo contra la configuración de depósitos. */
function stkDiagnosticoDepositos_(sesion, empresa) {
  const dep = stkDepositos_(sesion, empresa);
  const nombres = Object.keys(dep.info).sort((a, b) =>
    stkOrdenGrupo_(dep.info[a].grupo) - stkOrdenGrupo_(dep.info[b].grupo) || a.localeCompare(b, 'es'));

  stkEscribir_('DIAGNOSTICO DEPOSITOS',
    ['Depósito en el reporte', 'Código del almacén', 'Grupo', 'Tipo'],
    nombres.map(n => {
      const i = dep.info[n];
      return [n, i.cod, i.grupo, stkTipoDeposito_(i)];
    }), []);

  const codigos = {};
  nombres.forEach(n => { codigos[stkNorm_(dep.info[n].cod)] = true; codigos[stkNorm_(n)] = true; });
  const configurados = [];
  STK.GRUPOS_DEPOSITO.forEach(g => g.codigos.forEach(c => configurados.push(c)));
  STK.DEPOSITOS_MUESTRARIO.concat(STK.DEPOSITOS_ABASTECIMIENTO)
    .forEach(c => { if (configurados.indexOf(c) < 0) configurados.push(c); });

  return {
    almacenes: Object.keys(dep.almacenes).length,
    faltan: configurados.filter(c => !codigos[stkNorm_(c)]),
    sinGrupo: nombres.filter(n => dep.info[n].grupo === STK.GRUPO_DEFECTO),
    noComerciales: nombres.filter(n => dep.info[n].nc),
  };
}


/**
 * Cuánto stock queda fuera del reporte, y cuánto cuelga de la categoría
 * raíz ALL.
 *
 * Si las categorías excluidas tienen valor, el total del reporte no va a
 * coincidir con la valorización contable de Odoo.
 */
function stkRevisarExcluidas() {
  const { sesion, empresa } = stkConectar_();

  const meta = stkCamposDe_(sesion, 'product.template');
  const plantillas = stkPlantillas_(sesion, empresa, meta, ['id', 'categ_id', 'standard_price']);

  const categoriaPorPlantilla = {};
  const costoPorPlantilla = {};
  plantillas.forEach(t => {
    categoriaPorPlantilla[t.id] = stkNombre_(t.categ_id);
    costoPorPlantilla[t.id] = stkNum_(t.standard_price);
  });
  const plantillaPorVariante = stkVariantes_(sesion, plantillas.map(t => t.id));
  const stock = stkValorPorPlantilla_(sesion, empresa, costoPorPlantilla, plantillaPorVariante);

  const porCategoria = {};
  let total = 0;
  Object.keys(stock.valor).forEach(plantilla => {
    const categoria = categoriaPorPlantilla[plantilla];
    const monto = stock.valor[plantilla];
    if (categoria === undefined || !monto) return;
    if (!porCategoria[categoria]) porCategoria[categoria] = { monto: 0, articulos: 0 };
    porCategoria[categoria].monto += monto;
    porCategoria[categoria].articulos += 1;
    total += monto;
  });

  let excluido = 0;
  let enRaiz = 0;
  const filas = Object.keys(porCategoria).sort((a, b) => porCategoria[b].monto - porCategoria[a].monto)
    .map(categoria => {
      const dato = porCategoria[categoria];
      const esRaiz = stkNorm_(stkHojaCategoria_(categoria)) === stkNorm_('ALL');
      const excluida = stkExcluida_(categoria);
      if (excluida) excluido += dato.monto;
      if (esRaiz) enRaiz += dato.monto;
      return [
        categoria,
        excluida ? 'FUERA del reporte' : (esRaiz ? 'ENTRA, colgado de la raíz' : 'entra'),
        dato.articulos,
        Math.round(dato.monto),
        total ? (dato.monto / total * 100).toFixed(2) + '%' : '',
      ];
    });

  stkEscribir_('DIAGNOSTICO EXCLUIDAS',
    ['Categoría', 'Situación', 'Artículos con stock', 'Valor (Gs.)', '% del total'],
    filas, [3, 4]);
  stkSS_().setActiveSheet(stkHoja_('DIAGNOSTICO EXCLUIDAS'));

  const gs = n => new Intl.NumberFormat('es-PY').format(Math.round(n));
  stkAvisar_('Qué queda afuera', [
    `Stock total valorizado: Gs. ${gs(total)}`,
    `Valorizado con: ${stkNombreModo_(stock.modo)}`,
    '',
    `Excluido del reporte: Gs. ${gs(excluido)} (${total ? (excluido / total * 100).toFixed(2) : 0}%)`,
    excluido
      ? 'El total del reporte NO va a coincidir con la valorización contable.'
      : 'Las categorías excluidas no tienen stock. El total va a cuadrar.',
    '',
    `Colgado de la raíz ALL: Gs. ${gs(enRaiz)}`,
    enRaiz
      ? 'Esos productos aparecen en el reporte con la familia "All".'
      : 'Ningún producto cuelga de la raíz. Sin problema.',
    '',
    'Detalle en la hoja DIAGNOSTICO EXCLUIDAS.',
  ].join('\n'));
}


/**
 * Lista los campos personalizados de product.template con su etiqueta, su
 * nombre técnico, cuántos productos lo tienen cargado y tres valores de
 * ejemplo.
 */
function stkCamposPersonalizados() {
  const { sesion, empresa } = stkConectar_();

  const meta = stkCamposDe_(sesion, 'product.template');
  const candidatos = Object.keys(meta).filter(nombre => {
    if (nombre.indexOf('x_') === 0) return true;
    const c = meta[nombre];
    return c && c.manual === true;
  }).sort();

  if (!candidatos.length) {
    stkAvisar_('Campos personalizados', 'No se encontró ninguno en product.template.');
    return;
  }

  const productos = stkPlantillas_(sesion, empresa, meta, ['id'].concat(candidatos));

  const filas = candidatos.map(nombre => {
    const c = meta[nombre];
    let cargados = 0;
    const ejemplos = [];
    const distintos = {};
    productos.forEach(p => {
      const v = p[nombre];
      if (v === false || v === null || v === undefined || v === '') return;
      cargados += 1;
      const texto = Array.isArray(v) ? String(v[1]) : String(v);
      distintos[texto] = true;
      if (ejemplos.length < 3 && ejemplos.indexOf(texto) < 0) ejemplos.push(texto);
    });
    return [
      c.string || '',
      nombre,
      c.type || '',
      cargados,
      productos.length ? (cargados / productos.length * 100).toFixed(1) + '%' : '',
      Object.keys(distintos).length,
      ejemplos.join(' · '),
    ];
  }).sort((a, b) => b[3] - a[3]);

  stkEscribir_('CAMPOS ODOO',
    ['Etiqueta', 'Nombre técnico', 'Tipo', 'Productos con valor', '% cargado',
     'Valores distintos', 'Ejemplos'],
    filas, [4, 6]);
  stkSS_().setActiveSheet(stkHoja_('CAMPOS ODOO'));

  /* Un candidato a clasificación tiene muchos productos cargados y una
     cantidad razonable de valores distintos: ni uno solo, ni uno por producto. */
  const probables = filas.filter(f =>
    f[3] > productos.length * 0.3 && f[5] > 3 && f[5] < productos.length * 0.5);

  stkAvisar_('Campos personalizados', [
    `Productos analizados: ${productos.length}`,
    `Campos personalizados encontrados: ${filas.length}`,
    '',
    probables.length
      ? 'Posibles campos de clasificación:\n' +
        probables.slice(0, 8).map(f => `· ${f[0]} (${f[1]}) — ${f[3]} productos, ${f[5]} valores`).join('\n')
      : 'Ninguno parece un campo de clasificación.',
    '',
    'Detalle completo en la hoja CAMPOS ODOO.',
  ].join('\n'));
}


/**
 * Dos revisiones en una corrida:
 *
 * 1. ETIQUETAS de producto, pesadas por valor de stock.
 *
 * 2. Los DOS campos de categoría de rotación que existen con nombres casi
 *    iguales. El bueno es x_studio_categoria_de_rotacion; el otro es un espejo
 *    de la variante. Si no coinciden, conviene saberlo antes de leer el ABC.
 */
function stkEtiquetas() {
  const { sesion, empresa } = stkConectar_();

  const meta = stkCamposDe_(sesion, 'product.template');
  const campoEtiquetas = meta.product_tag_ids ? 'product_tag_ids' : null;
  const gemelos = ['x_studio_categoria_de_rotacion', 'x_studio_categoria_de_rotacin']
    .filter(c => meta[c]);

  const productos = stkPlantillas_(sesion, empresa, meta,
    ['id', 'name', 'default_code', 'categ_id', 'standard_price']
      .concat(campoEtiquetas ? [campoEtiquetas] : [])
      .concat(gemelos));

  const costo = {};
  productos.forEach(p => { costo[p.id] = stkNum_(p.standard_price); });
  const plantillaPorVariante = stkVariantes_(sesion, productos.map(p => p.id));
  const valor = stkValorPorPlantilla_(sesion, empresa, costo, plantillaPorVariante).valor;

  /* ---- 1. etiquetas ---- */
  if (!campoEtiquetas) {
    stkAvisar_('Etiquetas', 'Este Odoo no tiene el campo product_tag_ids.');
  } else {
    const ids = {};
    productos.forEach(p => (p[campoEtiquetas] || []).forEach(id => { ids[id] = true; }));
    const nombrePorId = {};
    stkLotes_(Object.keys(ids).map(Number), STK.LOTE_API).forEach(lote => {
      stkEjecutar_(sesion, 'product.tag', 'read', [lote], { fields: ['id', 'name'] })
        .forEach(t => { nombrePorId[t.id] = t.name; });
    });

    const conteo = {};
    let sinEtiqueta = 0;
    productos.forEach(p => {
      const etiquetas = p[campoEtiquetas] || [];
      if (!etiquetas.length) { sinEtiqueta += 1; return; }
      etiquetas.forEach(id => {
        const n = nombrePorId[id] || ('#' + id);
        if (!conteo[n]) conteo[n] = { productos: 0, valor: 0 };
        conteo[n].productos += 1;
        conteo[n].valor += valor[p.id] || 0;
      });
    });

    const filas = Object.keys(conteo)
      .sort((a, b) => conteo[b].valor - conteo[a].valor)
      .map(n => [n, conteo[n].productos, Math.round(conteo[n].valor)]);

    stkEscribir_('ETIQUETAS',
      ['Etiqueta', 'Productos', 'Valor de stock (Gs.)'], filas, [2, 3]);

    stkAvisar_('Etiquetas de producto', [
      `Etiquetas distintas: ${filas.length}`,
      `Productos sin ninguna etiqueta: ${sinEtiqueta} de ${productos.length}`,
      '',
      'Las 10 de mayor valor:',
      filas.slice(0, 10).map(f => `· ${f[0]} — ${f[1]} productos`).join('\n'),
      '',
      'Detalle en la hoja ETIQUETAS.',
    ].join('\n'));
  }

  /* ---- 2. los dos campos de rotación ---- */
  if (gemelos.length === 2) {
    const visible = (campo, v) => stkVisible_(meta[campo], v) || '';
    let iguales = 0, distintos = 0, soloA = 0, soloB = 0, ambosVacios = 0;
    const ejemplos = [];
    productos.forEach(p => {
      const a = visible(gemelos[0], p[gemelos[0]]);
      const b = visible(gemelos[1], p[gemelos[1]]);
      if (!a && !b) { ambosVacios += 1; return; }
      if (a && !b) { soloA += 1; }
      else if (!a && b) { soloB += 1; }
      else if (stkNorm_(a) === stkNorm_(b)) { iguales += 1; return; }
      else { distintos += 1; }
      if (ejemplos.length < 40) {
        ejemplos.push([p.default_code || '', p.name || '', a || '(vacío)', b || '(vacío)',
                       Math.round(valor[p.id] || 0)]);
      }
    });

    stkEscribir_('ROTACION DUPLICADA',
      ['Referencia', 'Producto', gemelos[0], gemelos[1], 'Valor de stock (Gs.)'],
      ejemplos, [5]);

    stkAvisar_('Campos de rotación duplicados', [
      `Coinciden: ${iguales}`,
      `Difieren: ${distintos}`,
      `Solo en ${gemelos[0]}: ${soloA}`,
      `Solo en ${gemelos[1]}: ${soloB}`,
      `Vacíos en los dos: ${ambosVacios}`,
      '',
      `El reporte lee ${STK.CAMPO_ABC}.`,
      (distintos + soloA + soloB) === 0
        ? 'Los dos campos dicen lo mismo.'
        : 'HAY DIFERENCIAS. Ver la hoja ROTACION DUPLICADA.',
    ].join('\n'));
  }
}


/**
 * Muestra, para un producto, todo lo que el reporte usa para valorizarlo:
 * cada existencia con su ubicación, la cantidad, el valor que reporta Odoo y
 * el que sale de multiplicar por el costo de la ficha; y las capas de
 * valorización de las que sale ese valor.
 */
function stkAuditarProducto() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Auditar un producto',
    'Referencia interna o parte del nombre', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const busca = String(r.getResponseText() || '').trim();
  if (!busca) return;

  const { sesion, empresa } = stkConectar_();

  const meta = stkCamposDe_(sesion, 'product.template');
  const plantillas = stkLeerTodo_(sesion, 'product.template', [
    '|', ['default_code', 'ilike', busca], ['name', 'ilike', busca],
    ['active', '=', true],
  ], stkCamposQueExisten_(meta,
    ['id', 'name', 'default_code', 'standard_price', 'uom_id', 'categ_id']), 'id asc');

  if (!plantillas.length) { stkAvisar_('Auditar', 'No se encontró ningún producto.'); return; }

  const filas = [];
  const metaQuant = stkCamposDe_(sesion, 'stock.quant');
  const hayValor = Boolean(metaQuant.value);
  const modo = stkModoValor_(metaQuant);
  const dep = stkDepositos_(sesion, empresa);
  const idsVar = [];

  plantillas.slice(0, 5).forEach(t => {
    const variantes = stkLeerTodo_(sesion, 'product.product',
      [['product_tmpl_id', '=', t.id]], ['id', 'default_code'], 'id asc');
    const ids = variantes.map(v => v.id);
    if (!ids.length) return;
    ids.forEach(id => idsVar.push(id));

    const quants = stkLeerTodo_(sesion, 'stock.quant', [
      ['company_id', '=', empresa.id],
      ['product_id', 'in', ids],
      ['location_id.usage', '=', 'internal'],
    ], stkCamposQueExisten_(metaQuant,
      ['id', 'product_id', 'location_id', 'quantity', 'value']), 'id asc');

    let sumaCant = 0, sumaOdoo = 0, sumaCalc = 0;
    quants.forEach(q => {
      const cant = stkNum_(q.quantity);
      const valOdoo = hayValor ? stkNum_(q.value) : 0;
      const valCalc = cant * stkNum_(t.standard_price);
      sumaCant += cant; sumaOdoo += valOdoo; sumaCalc += valCalc;
      filas.push([
        t.default_code || '', t.name || '',
        dep.porUbicacion[stkId_(q.location_id)] || 'Sin depósito', stkNombre_(q.location_id),
        cant, stkNum_(t.standard_price), Math.round(valOdoo), Math.round(valCalc),
        Math.round(cant ? valOdoo / cant : 0),
      ]);
    });

    filas.push(['', 'TOTAL ' + (t.default_code || t.name), '', '',
      sumaCant, stkNum_(t.standard_price), Math.round(sumaOdoo), Math.round(sumaCalc),
      Math.round(sumaCant ? sumaOdoo / sumaCant : 0)]);
    filas.push(['', '', '', '', '', '', '', '', '']);
  });

  const metaCapa = stkCamposDe_(sesion, 'stock.valuation.layer');
  const campoFecha = metaCapa.create_date ? 'create_date' : 'date';
  const capas = idsVar.length ? stkLeerTodo_(sesion, 'stock.valuation.layer', [
    ['company_id', '=', empresa.id],
    ['product_id', 'in', idsVar],
  ], stkCamposQueExisten_(metaCapa,
    ['id', 'product_id', 'quantity', 'unit_cost', 'value', 'remaining_qty',
     'remaining_value', 'description', campoFecha]), campoFecha + ' asc') : [];

  let acumQ = 0, acumV = 0;
  const filasCapas = capas.map(c => {
    acumQ += stkNum_(c.quantity);
    acumV += stkNum_(c.value);
    return [
      String(c[campoFecha] || '').substring(0, 10),
      stkTexto_(c.description).substring(0, 60),
      stkNum_(c.quantity), Math.round(stkNum_(c.unit_cost)), Math.round(stkNum_(c.value)),
      Math.round(acumQ * 10000) / 10000, Math.round(acumV),
      Math.round(stkNum_(c.remaining_qty) * 10000) / 10000,
      Math.round(stkNum_(c.remaining_value)),
    ];
  });
  stkEscribir_('AUDITORIA CAPAS',
    ['Fecha', 'Movimiento', 'Cantidad', 'Costo unitario (Gs.)', 'Valor (Gs.)',
     'Cantidad acumulada', 'Valor acumulado (Gs.)', 'Cantidad restante', 'Valor restante (Gs.)'],
    filasCapas, [3, 4, 5, 6, 7, 8, 9]);

  stkEscribir_('AUDITORIA',
    ['Referencia', 'Producto', 'Depósito', 'Ubicación', 'Cantidad', 'Costo de la ficha (Gs.)',
     'Valor según Odoo (Gs.)', 'Cantidad × costo ficha (Gs.)', 'Costo real por unidad (Gs.)'],
    filas, [5, 6, 7, 8, 9]);
  stkSS_().setActiveSheet(stkHoja_('AUDITORIA'));

  stkAvisar_('Auditoría', [
    'Capas de valorización: ' + capas.length,
    'Cantidad según las capas: ' + (Math.round(acumQ * 10000) / 10000),
    'Valor según las capas: ' + Math.round(acumV),
    '',
    'Ese valor debería coincidir con el total de "Valor según Odoo" en la hoja',
    'AUDITORIA, salvo mercadería en tránsito.',
    '',
    'El reporte usa: ' + stkNombreModo_(modo) + '.',
    modo === 'quant'
      ? 'Es la columna "Valor según Odoo".'
      : 'Es la columna "Cantidad × costo ficha".',
    '',
    'Para confirmarlo en Odoo: Inventario → Informes → Valoración, filtrando por el producto.',
  ].join('\n'));
}


/**
 * Revisa, producto por producto, que el valor de stock.quant sea confiable.
 *
 * En Vitalica el reporte se valoriza con ese valor, así que es lo que hay que
 * auditar. Se compara contra dos referencias:
 *   · la suma de las capas de valorización, que es de donde Odoo saca el
 *     valor: si no coinciden, hay valor en tránsito o un arrastre contable;
 *   · cantidad × costo de la ficha, solo cuando el costo está cargado.
 * Y se marcan los casos que no tienen sentido: cantidad sin valor, valor sin
 * cantidad, o valores negativos.
 */
function stkDesvios() {
  const { sesion, empresa } = stkConectar_();

  const meta = stkCamposDe_(sesion, 'product.template');
  const plantillas = stkPlantillas_(sesion, empresa, meta,
    ['id', 'name', 'default_code', 'standard_price']);

  const info = {};
  plantillas.forEach(t => {
    info[t.id] = { ref: t.default_code || '', nombre: stkLimpiar_(t.name || ''),
                   costo: stkNum_(t.standard_price) };
  });
  const plantillaPorVariante = stkVariantes_(sesion, plantillas.map(t => t.id));

  const metaQuant = stkCamposDe_(sesion, 'stock.quant');
  if (!metaQuant.value) {
    stkAvisar_('Desvíos', 'El usuario API no ve el campo de valor de stock.quant: no se puede revisar.');
    return;
  }

  const acum = {};
  const nuevo = () => ({ cant: 0, quant: 0, capasQ: 0, capasV: 0 });
  stkLeerTodo_(sesion, 'stock.quant', [
    ['company_id', '=', empresa.id],
    ['location_id.usage', '=', 'internal'],
  ], ['id', 'product_id', 'quantity', 'value'], 'id asc').forEach(q => {
    const t = plantillaPorVariante[stkId_(q.product_id)];
    if (!t) return;
    if (!acum[t]) acum[t] = nuevo();
    acum[t].cant += stkNum_(q.quantity);
    acum[t].quant += stkNum_(q.value);
  });

  stkLeerTodo_(sesion, 'stock.valuation.layer', [['company_id', '=', empresa.id]],
    ['id', 'product_id', 'quantity', 'value'], 'id asc').forEach(c => {
    const t = plantillaPorVariante[stkId_(c.product_id)];
    if (!t) return;
    if (!acum[t]) acum[t] = nuevo();
    acum[t].capasQ += stkNum_(c.quantity);
    acum[t].capasV += stkNum_(c.value);
  });

  const TOL = 1000;
  let totalQuant = 0, totalCapas = 0, conObservacion = 0;
  const filas = Object.keys(acum).map(t => {
    const a = acum[t];
    const p = info[t] || { ref: '', nombre: '(sin datos)', costo: 0 };
    const calc = a.cant * p.costo;
    totalQuant += a.quant;
    totalCapas += a.capasV;

    const obs = [];
    if (a.cant > 0 && a.quant <= 0) obs.push('tiene cantidad y no tiene valor');
    if (Math.abs(a.cant) < 0.0001 && Math.abs(a.quant) > TOL) obs.push('tiene valor y no tiene cantidad');
    if (a.cant < 0) obs.push('cantidad negativa');
    if (a.quant < -TOL) obs.push('valor negativo');
    if (Math.abs(a.quant - a.capasV) > TOL) obs.push('stock.quant no coincide con las capas');
    if (p.costo > 0 && Math.abs(calc - a.quant) > TOL) obs.push('no coincide con cantidad × costo de la ficha');
    if (obs.length) conObservacion += 1;

    return [p.ref, p.nombre, Math.round(a.cant * 100) / 100, Math.round(a.quant),
            Math.round(a.capasQ * 100) / 100, Math.round(a.capasV),
            Math.round(a.quant - a.capasV), Math.round(p.costo), Math.round(calc),
            a.cant > 0 ? Math.round(a.quant / a.cant) : '', obs.join(' · ')];
  }).filter(f => f[10])
    .sort((a, b) => Math.abs(b[6]) - Math.abs(a[6]) || Math.abs(b[3]) - Math.abs(a[3]));

  stkEscribir_('DESVIOS VALORIZACION',
    ['Referencia', 'Producto', 'Cantidad en depósitos', 'Valor stock.quant (Gs.)',
     'Cantidad según capas', 'Valor según capas (Gs.)', 'Diferencia quant − capas (Gs.)',
     'Costo de la ficha (Gs.)', 'Cantidad × costo ficha (Gs.)', 'Costo implícito por unidad (Gs.)',
     'Observación'],
    filas, [3, 4, 5, 6, 7, 8, 9, 10]);
  stkSS_().setActiveSheet(stkHoja_('DESVIOS VALORIZACION'));

  const gs = n => new Intl.NumberFormat('es-PY').format(Math.round(n));
  stkAvisar_('Desvíos de valorización', [
    `Productos revisados: ${Object.keys(acum).length}`,
    `Con alguna observación: ${conObservacion}`,
    '',
    `Valor en stock.quant (depósitos internos): Gs. ${gs(totalQuant)}`,
    `Valor según las capas de valorización:     Gs. ${gs(totalCapas)}`,
    `Diferencia:                                Gs. ${gs(totalQuant - totalCapas)}`,
    '',
    'Una diferencia chica suele ser mercadería en tránsito o en ubicaciones que',
    'no son depósito. Una grande, o productos con cantidad y sin valor, son lo',
    'que hay que mirar antes de dar por buena la cifra del reporte.',
    '',
    'Detalle en la hoja DESVIOS VALORIZACION.',
  ].join('\n'));
}


/* ==========================================================================
   2. MARCAS
   ==========================================================================
   En Vitalica product_brand_id está vacío y el reporte se arma por familia.
   Esto solo confirma que sigue así: si un día se cargan marcas, avisa.
   ========================================================================== */

function stkDetectarMarcas() {
  const { sesion, empresa } = stkConectar_();

  const meta = stkCamposDe_(sesion, 'product.template');
  if (!meta[STK.CAMPO_MARCA]) {
    stkAvisar_('Marcas', `El campo ${STK.CAMPO_MARCA} no existe en este Odoo. El reporte se arma por familia.`);
    return;
  }
  const productos = stkPlantillas_(sesion, empresa, meta,
    ['id', 'name', 'default_code', 'categ_id', STK.CAMPO_MARCA]);

  const filas = productos
    .filter(p => p[STK.CAMPO_MARCA])
    .map(p => [String(p.default_code || '').trim(), stkLimpiar_(p.name || ''),
               stkFamilia_(stkNombre_(p.categ_id)),
               stkLimpiar_(stkNombre_(p[STK.CAMPO_MARCA]))]);

  stkEscribir_(STK.HOJAS.MARCAS, ['Referencia', 'Producto', 'Familia', 'Marca'], filas, []);

  stkAvisar_('Marcas', [
    `Productos almacenables: ${productos.length}`,
    `Con marca cargada: ${filas.length}`,
    '',
    filas.length
      ? 'Hay marcas cargadas. El reporte sigue armado por familia: si se completan ' +
        'en todo el catálogo, conviene evaluar volver al esquema por marca.'
      : 'Ninguno tiene marca. Es lo esperado: el reporte se arma por familia.',
  ].join('\n'));
}


/* ==========================================================================
   3. ACTUALIZAR DATOS
   ========================================================================== */

/**
 * Extrae de Odoo, escribe las hojas y DEVUELVE los datos armados en memoria.
 *
 * El valor devuelto es lo que se publica. No se vuelve a leer de la planilla:
 * Google Sheets convierte textos como "30-06" o "5.11" en fechas y ese viaje
 * de ida y vuelta corrompe los datos. Las hojas quedan para consultar a mano,
 * no como fuente del reporte.
 */
function stkActualizarDatos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { stkAvisar_('Reporte de Stock', 'Ya hay otra ejecución en curso.'); return null; }
  try {
    STK_SIN_PERMISO = [];
    stkToast_('Conectando con Odoo...');
    const { sesion, empresa } = stkConectar_();

    stkToast_('Leyendo productos...');
    const productos = stkProductos_(sesion, empresa);

    stkToast_('Leyendo existencias valorizadas...');
    const stock = stkStock_(sesion, empresa, productos);
    stkEscribir_(STK.HOJAS.STOCK,
      ['Familia', 'Depósito', 'Grupo', 'Tipo', 'Categoría', 'Cantidad', 'Valor (Gs.)'],
      stock.filas, [6, 7]);
    stkEscribir_(STK.HOJAS.ARTICULOS,
      ['Referencia', 'Producto', 'Familia', 'Depósito', 'Categoría', 'Cantidad', 'Valor (Gs.)'],
      stock.articulos, [6, 7]);

    stkToast_('Leyendo salidas a cliente...');
    const salidas = stkSalidas_(sesion, empresa, productos, stock.depositos);
    stkEscribir_(STK.HOJAS.ROTACION,
      ['Familia', `Costo de venta ${STK.MESES_ROTACION} meses (Gs.)`],
      Object.keys(salidas.cmvFam).sort().map(m => [m, Math.round(salidas.cmvFam[m])]), [2]);

    stkToast_('Reconstruyendo el histórico...');
    const hist = stkHistorico_(sesion, empresa, productos, stock.valorPorFamilia, stock.valorPorArticulo);
    const columnas = [];
    for (let i = 2; i <= hist.cierres.length + 1; i++) columnas.push(i);
    stkEscribir_(STK.HOJAS.HISTORICO,
      ['Familia'].concat(hist.cierres.map(c => c.etiqueta)), hist.filasFam, columnas);
    /* Que Sheets no interprete "ene 26" como fecha. */
    stkHoja_(STK.HOJAS.HISTORICO)
      .getRange(1, 1, 1, hist.cierres.length + 1).setNumberFormat('@');

    /* Rotación por artículo y depósito: el cruce de lo que hay con lo que se
       vendió en cada lugar. Es la pregunta propia de Vitalica: qué rota en
       cada gimnasio y qué está parado. */
    const rotDep = stkRotacionDepositos_(stock, salidas);
    stkEscribir_(STK.HOJAS.DEPOSITOS,
      ['Depósito', 'Código', 'Grupo', 'Tipo', 'Unidades en stock',
       'Valor (Gs.)', `Unidades vendidas ${STK.MESES_ROTACION} meses`,
       `Costo de venta ${STK.MESES_ROTACION} meses (Gs.)`, 'Última venta'],
      rotDep.resumen, [5, 6, 7, 8]);

    /* Auditoría: queda en la hoja BITACORA de la planilla. */
    const cambio = stkBitacora_(stock);

    SpreadsheetApp.flush();

    /* Datos para el reporte, tomados de memoria y no de las hojas.
       Los montos van en millones con tres decimales, es decir, redondeados a
       Gs. 1.000: los gimnasios tienen stock de pocos millones y redondear a
       Gs. 100.000 como en Camping 44 borraba la diferencia entre ellos. */
    const aM = v => Math.round(stkNum_(v) / 1000) / 1000;
    const q2 = v => Math.round(stkNum_(v) * 100) / 100;
    const D = {
      CATS: STK_CATS, GENERADO: stkAhora_(), EMPRESA: STK.EMPRESA, NORMA: STK.NORMA,
      VALORIZACION: stock.modo,
      GRUPOS: stkGruposEnOrden_(),
      DEPOS: rotDep.depos,
      NO_COMERCIAL: Object.keys(rotDep.depos).filter(d => rotDep.depos[d].nc),
      MUESTRARIO: Object.keys(rotDep.depos).filter(d => rotDep.depos[d].mues),
      ABASTECIMIENTO: Object.keys(rotDep.depos).filter(d => rotDep.depos[d].abas),
      UMBRALES: { min: STK.COBERTURA_MINIMA, max: STK.COBERTURA_MAXIMA },
      MESES: hist.cierres.map(c => c.etiqueta),
      MESES_ROT: STK.MESES_ROTACION,
      MESES_VENTA: (salidas.mesesVenta || []).map(m => m.etiqueta),
      CAMBIO: cambio,
      STOCK: stock.filas.map(r => ({
        fam: r[0], dep: r[1], cat: r[4], q: q2(r[5]), v: aM(r[6]),
      })),
      ARTICULOS: stock.articulos.map(a => [a[0], a[1], a[2], a[3], a[4], q2(a[5]), aM(a[6])]),
      ROT_DEP: rotDep.filas.map(r => [r[0], r[1], r[2], r[3], r[4], q2(r[5]), aM(r[6]),
                                      q2(r[7]), aM(r[8]), r[9].map(q2), r[10]]),
      SERIES_FAM: {}, CMV6_FAM: {}, SERIES_ART: {}, ROT_ART: [],
    };
    hist.filasArt.forEach(fila => { D.SERIES_ART[fila[0]] = fila.slice(1).map(aM); });
    hist.filasFam.forEach(fila => { D.SERIES_FAM[fila[0]] = fila.slice(1).map(aM); });
    Object.keys(salidas.cmvFam).forEach(x => { D.CMV6_FAM[x] = aM(salidas.cmvFam[x]); });

    /* Rotación por artículo, a nivel empresa: costo de venta de 6 meses contra
       el stock actual. El denominador es el stock de hoy y no un promedio:
       sirve para comparar productos entre sí dentro de una familia. */
    const stockArt = {};
    stock.articulos.forEach(a => {
      const k = a[0] + '|' + a[1];
      if (!stockArt[k]) stockArt[k] = { ref: a[0], nombre: a[1], fam: a[2], cat: a[4], v: 0, q: 0 };
      stockArt[k].v += stkNum_(a[6]);
      stockArt[k].q += stkNum_(a[5]);
    });

    const ventaPorRef = {};
    Object.keys(salidas.cmvArt).forEach(id => {
      const x = salidas.cmvArt[id];
      const k = x.ref + '|' + x.nombre;
      if (!ventaPorRef[k]) {
        ventaPorRef[k] = { v: 0, q: 0, fam: x.fam, cat: x.cat, canal: {},
                           porMes: salidas.mesesVenta.map(() => 0) };
      }
      ventaPorRef[k].v += x.v;
      ventaPorRef[k].q += x.q;
      x.porMes.forEach((q, i) => { ventaPorRef[k].porMes[i] += q; });
      Object.keys(x.porCanal).forEach(c => {
        if (!ventaPorRef[k].canal[c]) ventaPorRef[k].canal[c] = { q: 0, v: 0 };
        ventaPorRef[k].canal[c].q += x.porCanal[c].q;
        ventaPorRef[k].canal[c].v += x.porCanal[c].v;
      });
    });

    Object.keys(stockArt).forEach(k => {
      const a = stockArt[k];
      const venta = ventaPorRef[k] || { v: 0, q: 0, canal: {}, porMes: [] };
      if (a.v <= 0 && venta.v <= 0 && a.q <= 0 && venta.q <= 0) return;
      D.ROT_ART.push([a.ref, a.nombre, a.fam, aM(venta.v), aM(a.v), q2(venta.q), q2(a.q),
                      a.cat || '', stkCanalesDe_(venta.canal), venta.porMes.map(q2)]);
    });
    Object.keys(ventaPorRef).forEach(k => {
      if (stockArt[k]) return;   /* vendió y no le queda stock */
      const p = k.split('|');
      const x = ventaPorRef[k];
      D.ROT_ART.push([p[0], p[1], x.fam || '', aM(x.v), 0, q2(x.q), 0,
                      x.cat || '', stkCanalesDe_(x.canal), x.porMes.map(q2)]);
    });
    D.ROT_ART.sort((a, b) => b[5] - a[5]);

    PropertiesService.getScriptProperties()
      .setProperty('STK_ULTIMA_EXTRACCION', D.GENERADO);

    stkAvisar_('Datos actualizados', [
      `Filas de stock: ${stock.filas.length}`,
      `Artículos por depósito: ${stock.articulos.length}`,
      `Líneas de venta: ${salidas.lineas}`,
      `Familias con histórico: ${hist.filasFam.length}`,
      `Valorizado con: ${stkNombreModo_(stock.modo)}`,
      '',
      stock.modo === 'costo' && stock.total === 0 && stock.unidades > 0
        ? 'ATENCIÓN: el stock da Gs. 0. El costo de la ficha está en cero: ' +
          'revisar STK.VALORIZAR_CON.'
        : '',
      stock.modo === 'costo' && Math.abs(stock.desvio) > 1000000
        ? 'Aviso: el valor contable de Odoo difiere en Gs. ' +
          new Intl.NumberFormat('es-PY').format(Math.round(stock.desvio)) +
          '. Ver "Detectar desvíos de valorización".'
        : '',
      salidas.sinCapa
        ? `Aviso: ${salidas.sinCapa} salidas a cliente no tienen capa de valorización ` +
          'y no se cuentan en la rotación.'
        : '',
      STK_SIN_PERMISO.length
        ? 'Aviso: el usuario de Odoo del script no pudo leer ' +
          STK_SIN_PERMISO.join('; ') +
          '. El reporte se armó igual, pero sin ese dato.'
        : '',
      'Revisá las hojas STOCK, ARTICULOS, DEPOSITOS, HISTORICO y ROTACION.',
      '',
      cambio ? stkResumenCambio_(cambio) : 'Primera corrida registrada en BITACORA.',
    ].filter((linea, i, todas) => linea || (todas[i - 1] && todas[i - 1] !== '')).join('\n'));
    return D;
  } catch (error) {
    stkError_('Falló la actualización', error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function stkProductos_(sesion, empresa) {
  const meta = stkCamposDe_(sesion, 'product.template');
  const plantillas = stkPlantillas_(sesion, empresa, meta,
    ['id', 'name', 'default_code', 'categ_id', 'standard_price', STK.CAMPO_ABC]);

  const porPlantilla = {};
  const ids = [];
  plantillas.forEach(t => {
    const categoriaProducto = stkNombre_(t.categ_id);
    if (stkExcluida_(categoriaProducto)) return;   /* no es mercadería de venta */
    if (stkProductoExcluido_(t.default_code)) return;   /* excluido a mano */
    const p = {
      id: t.id,
      referencia: String(t.default_code || '').trim(),
      nombre: stkLimpiar_(t.name || ''),
      categoriaProducto,
      /* Familia: la hoja del árbol de categorías de Odoo (ALL / Suplementos
         (Padre) / <familia> o ALL / <familia>), salvo las unificadas. */
      familia: stkFamilia_(categoriaProducto),
      abc: stkVisible_(meta[STK.CAMPO_ABC], t[STK.CAMPO_ABC]),
      costo: stkNum_(t.standard_price),
    };
    p.cat = stkCategoria_(p);
    porPlantilla[t.id] = p;
    ids.push(t.id);
  });

  return { porPlantilla, plantillaPorVariante: stkVariantes_(sesion, ids) };
}


/**
 * Arregla el UTF-8 que Odoo devuelve mal decodificado: "CÃ³nico" -> "Cónico".
 */
function stkLimpiar_(texto) {
  if (!texto) return '';
  return String(texto)
    .replace(/Ã±/g, 'ñ').replace(/Ã‘/g, 'Ñ')
    .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú').replace(/Ã¼/g, 'ü')
    .replace(/Ã\u0081/g, 'Á').replace(/Ã‰/g, 'É').replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó').replace(/Ãš/g, 'Ú')
    .replace(/Â°/g, '°').replace(/Âº/g, 'º').replace(/Â/g, '')
    .trim();
}


/**
 * Categoría del reporte. A, B y C son la matriz; N es "Nuevo": producto recién
 * incorporado, sin historia de rotación. Es una decisión tomada, no un dato
 * faltante, y por eso va aparte. Todo lo demás, incluido lo que figura como
 * "Sin categoria", es NC.
 */
const STK_LETRAS = Object.freeze(['A', 'B', 'C', 'N']);

function stkCategoria_(p) {
  const abc = stkNorm_(p.abc);
  return STK_LETRAS.indexOf(abc) >= 0 ? abc : 'NC';
}

function stkHojaCategoria_(rutaCompleta) {
  const partes = String(rutaCompleta || '').split('/');
  return partes[partes.length - 1].trim();
}

/**
 * Familia del reporte para una categoría de Odoo: la de STK.FAMILIAS_UNIFICADAS
 * si la ruta termina en alguna de las configuradas, y si no, la última hoja.
 */
function stkFamilia_(rutaCompleta) {
  const tramos = String(rutaCompleta || '').split('/').map(stkNorm_);
  for (let i = 0; i < STK.FAMILIAS_UNIFICADAS.length; i++) {
    const regla = STK.FAMILIAS_UNIFICADAS[i];
    const coincide = regla.categorias.some(c => {
      const buscados = String(c).split('/').map(stkNorm_);
      if (buscados.length > tramos.length) return false;
      const cola = tramos.slice(tramos.length - buscados.length);
      return buscados.every((t, j) => t === cola[j]);
    });
    if (coincide) return regla.familia;
  }
  return stkLimpiar_(stkHojaCategoria_(rutaCompleta)) || 'Sin familia';
}

/** Referencias apartadas del reporte por decisión, no por categoría. */
function stkProductoExcluido_(referencia) {
  const r = stkNorm_(referencia);
  if (!r) return false;
  return STK.PRODUCTOS_EXCLUIDOS.some(x => stkNorm_(x) === r);
}

function stkExcluida_(categoriaProducto) {
  const hoja = stkNorm_(stkHojaCategoria_(categoriaProducto));
  return STK.CATEGORIAS_EXCLUIDAS.some(c => stkNorm_(c) === hoja);
}


/* ==========================================================================
   DEPÓSITOS
   ========================================================================== */

/** ¿El código o el nombre coinciden exactamente con algún elemento de la lista? */
function stkEnLista_(codigo, nombre, lista) {
  const c = stkNorm_(codigo), n = stkNorm_(nombre);
  return lista.some(x => { const k = stkNorm_(x); return k && (k === c || k === n); });
}

function stkGrupoDeposito_(codigo, nombre) {
  for (let i = 0; i < STK.GRUPOS_DEPOSITO.length; i++) {
    if (stkEnLista_(codigo, nombre, STK.GRUPOS_DEPOSITO[i].codigos)) return STK.GRUPOS_DEPOSITO[i].grupo;
  }
  return STK.GRUPO_DEFECTO;
}

/** Orden de los grupos en el reporte: los configurados, después los no comerciales y al final "Otros". */
function stkGruposEnOrden_() {
  return STK.GRUPOS_DEPOSITO.map(g => g.grupo).concat([STK.GRUPO_NO_COMERCIAL, STK.GRUPO_DEFECTO]);
}

function stkOrdenGrupo_(grupo) {
  const lista = stkGruposEnOrden_();
  const i = lista.indexOf(grupo);
  return i < 0 ? lista.length : i;
}

/** El tramo de la ruta que coincide con un depósito no comercial, o ''. */
function stkTramoNoComercial_(ruta) {
  const tramos = String(ruta || '').split('/').map(s => s.trim());
  for (let i = 0; i < tramos.length; i++) {
    const t = stkNorm_(tramos[i]);
    if (t && STK.DEPOSITOS_NO_COMERCIALES.some(x => t.indexOf(stkNorm_(x)) >= 0)) return tramos[i];
  }
  return '';
}

/**
 * Ubicación interna -> depósito del reporte.
 *
 * stock.quant guarda la ubicación exacta (un estante, un pasillo). El depósito
 * es el almacén al que pertenece (warehouse_id); si no está, la primera rama
 * del árbol de ubicaciones.
 *
 * Excepción: una ubicación no comercial (exhibición, marketing) se separa como
 * depósito propio aunque cuelgue de un almacén vendible. Si no, su stock se
 * sumaba al del almacén y no había forma de verlo aparte.
 *
 * Devuelve el mapa de ubicaciones y, por depósito, su código, grupo y si es
 * si es muestrario, de abastecimiento o no comercial.
 */
function stkDepositos_(sesion, empresa) {
  const almacenes = {};
  stkOpcional_('códigos de almacén (stock.warehouse)', () =>
    stkLeerTodo_(sesion, 'stock.warehouse', [['company_id', '=', empresa.id]],
      ['id', 'name', 'code'], 'id asc'), [])
    .forEach(w => {
      almacenes[w.id] = { nombre: stkLimpiar_(w.name || ''), cod: String(w.code || '').trim() };
    });

  const meta = stkCamposDe_(sesion, 'stock.location');
  const ubicaciones = stkLeerTodo_(sesion, 'stock.location', [
    ['usage', '=', 'internal'],
    '|', ['company_id', '=', false], ['company_id', '=', empresa.id],
  ], stkCamposQueExisten_(meta, ['id', 'name', 'complete_name', 'display_name', 'warehouse_id']),
  'id asc');

  const porUbicacion = {};
  const info = {};
  ubicaciones.forEach(u => {
    const ruta = stkLimpiar_(u.complete_name || u.display_name || u.name || '');
    const alm = almacenes[stkId_(u.warehouse_id)];
    const raiz = (ruta.split('/')[0] || '').trim();
    const cod = alm ? alm.cod : raiz;
    const base = alm ? (alm.nombre || alm.cod) : (raiz || 'Sin depósito');
    const tramo = stkTramoNoComercial_(ruta);
    const nombre = tramo || base;

    porUbicacion[u.id] = nombre;
    if (!info[nombre]) {
      const grupo = stkGrupoDeposito_(cod, base);
      info[nombre] = {
        cod: cod,
        grupo: tramo && grupo === STK.GRUPO_DEFECTO ? STK.GRUPO_NO_COMERCIAL : grupo,
        mues: !tramo && stkEnLista_(cod, base, STK.DEPOSITOS_MUESTRARIO),
        abas: !tramo && stkEnLista_(cod, base, STK.DEPOSITOS_ABASTECIMIENTO),
        nc: Boolean(tramo),
      };
    }
  });
  return { porUbicacion, info, almacenes };
}

function stkInfoDeposito_(depositos, nombre) {
  return depositos.info[nombre] ||
         { cod: '', grupo: STK.GRUPO_DEFECTO, mues: false, abas: false, nc: false };
}

function stkTipoDeposito_(i) {
  return i.nc ? 'No comercial' : i.mues ? 'Muestrario' : i.abas ? 'Abastecimiento' : 'Venta';
}


/**
 * Valorización del stock, abierta por familia, depósito y categoría.
 *
 * El monto sale de stkMonto_: en Vitalica, el valor de stock.quant (ver
 * STK.VALORIZAR_CON). Las unidades se guardan aparte porque en los
 * gimnasios, con pocos millones por depósito, la cantidad dice más.
 */
function stkStock_(sesion, empresa, productos) {
  const meta = stkCamposDe_(sesion, 'stock.quant');
  const modo = stkModoValor_(meta);
  if (STK.VALORIZAR_CON === 'quant' && modo !== 'quant') {
    STK_SIN_PERMISO.push('el valor de stock.quant — se valorizó con cantidad × costo de la ficha');
  }
  const depositos = stkDepositos_(sesion, empresa);

  const quants = stkLeerTodo_(sesion, 'stock.quant', [
    ['company_id', '=', empresa.id],
    ['location_id.usage', '=', 'internal'],
  ], stkCamposQueExisten_(meta, ['id', 'product_id', 'location_id', 'quantity', 'value']), 'id asc');

  let desvio = 0, total = 0, unidades = 0;
  const acumulado = {};
  const valorPorFamilia = {};
  const valorPorArticulo = {};
  const porArticulo = {};
  quants.forEach(q => {
    const p = productos.porPlantilla[productos.plantillaPorVariante[stkId_(q.product_id)]];
    if (!p) return;
    const cantidad = stkNum_(q.quantity);
    const monto = stkMonto_(modo, cantidad, q.value, p.costo);
    if (modo === 'costo') desvio += stkNum_(q.value) - monto;
    /* Se mira también la cantidad: un artículo con unidades y valor cero
       existe, y en un gimnasio es justamente uno de los que hay que ver. */
    if (!monto && !cantidad) return;
    total += monto;
    unidades += cantidad;

    const deposito = depositos.porUbicacion[stkId_(q.location_id)] || 'Sin depósito';
    const clave = `${p.familia}|${deposito}|${p.cat}`;
    if (!acumulado[clave]) acumulado[clave] = { q: 0, v: 0 };
    acumulado[clave].q += cantidad;
    acumulado[clave].v += monto;
    valorPorFamilia[p.familia] = (valorPorFamilia[p.familia] || 0) + monto;

    const claveArt = `${p.id}|${deposito}`;
    if (!porArticulo[claveArt]) {
      porArticulo[claveArt] = { id: p.id, ref: p.referencia, nombre: p.nombre, fam: p.familia,
                                dep: deposito, cat: p.cat, cant: 0, v: 0 };
    }
    porArticulo[claveArt].cant += cantidad;
    porArticulo[claveArt].v += monto;
    const claveSerie = p.referencia + '|' + p.nombre;
    valorPorArticulo[claveSerie] = (valorPorArticulo[claveSerie] || 0) + monto;
  });

  const filas = Object.keys(acumulado).sort().map(clave => {
    const k = clave.split('|');
    const d = stkInfoDeposito_(depositos, k[1]);
    return [k[0], k[1], d.grupo, stkTipoDeposito_(d), k[2],
            Math.round(acumulado[clave].q * 100) / 100, Math.round(acumulado[clave].v)];
  });
  const lista = Object.keys(porArticulo).map(k => porArticulo[k])
    .filter(a => a.v > 0 || a.cant > 0)
    .sort((a, b) => b.v - a.v || b.cant - a.cant);
  const articulos = lista.slice(0, STK.TOP_ARTICULOS)
    .map(a => [a.ref, a.nombre, a.fam, a.dep, a.cat,
               Math.round(a.cant * 100) / 100, Math.round(a.v)]);

  return { filas, articulos, porArticulo: lista, valorPorFamilia, valorPorArticulo,
           desvio, total, unidades, modo, depositos };
}

/**
 * Salidas a cliente de los últimos meses.
 *
 * El costo real de una venta está en la capa de valorización de la salida,
 * no en el precio de la línea de pedido. Se cuentan las capas con cantidad
 * negativa, no las de valor negativo: un producto con costo cero sale con
 * valor cero y sin esto sus unidades vendidas desaparecían de la rotación.
 */
function stkSalidas_(sesion, empresa, productos, depositos) {
  const desde = stkMesesAtras_(STK.MESES_ROTACION);
  /* Los meses de la ventana, en orden. La ventana arranca el día 1 del mes
     MESES_ROTACION hacia atrás, así que entran uno más que esa cantidad. */
  const mesesVenta = stkCierres_(STK.MESES_ROTACION + 1);
  const vacio = { lineas: 0, sinCapa: 0, cmvFam: {}, cmvArt: {}, porDeposito: {}, mesesVenta };

  const movimientos = stkLeerTodo_(sesion, 'stock.move', [
    ['company_id', '=', empresa.id],
    ['state', '=', 'done'],
    ['date', '>=', `${desde} 00:00:00`],
    ['location_dest_id.usage', '=', 'customer'],
  ], ['id', 'product_id', 'picking_id', 'location_id', 'date'], 'id asc');
  if (!movimientos.length) return vacio;

  /* Canal: primero el equipo de ventas del pedido, y si no hay, la lista de
     precios del cliente. */
  const canalPorCliente = stkOpcional_(
    'canal de venta por lista de precios del cliente',
    () => stkCanales_(sesion, empresa), {});
  const canalPorAlbaran = {};
  const idsAlbaran = Array.from(new Set(movimientos.map(m => stkId_(m.picking_id)).filter(Boolean)));
  const canalPorEquipo = stkOpcional_(
    'canal de venta por equipo del pedido',
    () => stkCanalPorPedido_(sesion, idsAlbaran), {});
  stkLotes_(idsAlbaran, STK.LOTE_API).forEach(lote => {
    stkEjecutar_(sesion, 'stock.picking', 'read', [lote], { fields: ['id', 'partner_id'] })
      .forEach(a => {
        canalPorAlbaran[a.id] = canalPorEquipo[a.id] ||
                                canalPorCliente[stkId_(a.partner_id)] ||
                                STK.CANAL_DEFECTO;
      });
  });

  const movPorId = {};
  movimientos.forEach(m => { movPorId[m.id] = m; });

  const capas = [];
  stkLotes_(movimientos.map(m => m.id), STK.LOTE_API).forEach(lote => {
    capas.push(...stkLeerTodo_(sesion, 'stock.valuation.layer', [['stock_move_id', 'in', lote]],
      ['id', 'stock_move_id', 'product_id', 'quantity', 'value'], 'id asc'));
  });

  const posMes = {};
  mesesVenta.forEach((m, i) => { posMes[m.mes] = i; });

  let lineas = 0;
  const conCapa = {};
  const cmvFam = {};
  const cmvArt = {};        /* por artículo, para la rotación de la Parte 2 */
  const porDeposito = {};   /* por artículo y depósito, para los gimnasios */
  capas.forEach(capa => {
    const cantidad = Math.abs(stkNum_(capa.quantity));
    if (stkNum_(capa.quantity) >= 0) return;
    const mov = movPorId[stkId_(capa.stock_move_id)];
    const p = productos.porPlantilla[productos.plantillaPorVariante[stkId_(capa.product_id)]];
    if (!mov) return;
    conCapa[mov.id] = true;
    if (!p) return;
    lineas += 1;

    const valor = Math.abs(stkNum_(capa.value));
    const fecha = String(mov.date || '').substring(0, 10);
    const i = posMes[fecha.substring(0, 7)];
    const canal = canalPorAlbaran[stkId_(mov.picking_id)] || STK.CANAL_DEFECTO;
    const deposito = depositos.porUbicacion[stkId_(mov.location_id)] || 'Sin depósito';

    cmvFam[p.familia] = (cmvFam[p.familia] || 0) + valor;

    if (!cmvArt[p.id]) {
      cmvArt[p.id] = { ref: p.referencia, nombre: p.nombre, fam: p.familia, cat: p.cat,
                       v: 0, q: 0, porCanal: {}, porMes: mesesVenta.map(() => 0) };
    }
    const a = cmvArt[p.id];
    a.v += valor;
    a.q += cantidad;
    /* Unidades mes a mes: es lo que Gerencia mira para ver si un producto se
       está muriendo de a poco o vendió todo de golpe en un mes. */
    if (i !== undefined) a.porMes[i] += cantidad;
    if (!a.porCanal[canal]) a.porCanal[canal] = { q: 0, v: 0 };
    a.porCanal[canal].q += cantidad;
    a.porCanal[canal].v += valor;

    const kd = `${p.id}|${deposito}`;
    if (!porDeposito[kd]) {
      porDeposito[kd] = { id: p.id, ref: p.referencia, nombre: p.nombre, fam: p.familia,
                          dep: deposito, cat: p.cat, q: 0, v: 0,
                          porMes: mesesVenta.map(() => 0), ultima: '' };
    }
    const d = porDeposito[kd];
    d.q += cantidad;
    d.v += valor;
    if (i !== undefined) d.porMes[i] += cantidad;
    if (fecha > d.ultima) d.ultima = fecha;
  });

  const sinCapa = movimientos.filter(m => !conCapa[m.id]).length;
  return { lineas, sinCapa, cmvFam, cmvArt, porDeposito, mesesVenta };
}

/**
 * Cruza stock y ventas por artículo y depósito.
 * filas: [ref, nombre, familia, depósito, cat, cant. stock, valor stock,
 *         cant. vendida, costo de venta, unidades por mes, última venta]
 */
function stkRotacionDepositos_(stock, salidas) {
  const cruce = {};
  stock.porArticulo.forEach(a => {
    cruce[a.id + '|' + a.dep] = { ref: a.ref, nombre: a.nombre, fam: a.fam, dep: a.dep, cat: a.cat,
                                  qs: a.cant, vs: a.v, qv: 0, vv: 0, porMes: null, ultima: '' };
  });
  Object.keys(salidas.porDeposito).forEach(k => {
    const s = salidas.porDeposito[k];
    if (!cruce[k]) {
      cruce[k] = { ref: s.ref, nombre: s.nombre, fam: s.fam, dep: s.dep, cat: s.cat,
                   qs: 0, vs: 0, qv: 0, vv: 0, porMes: null, ultima: '' };
    }
    cruce[k].qv = s.q;
    cruce[k].vv = s.v;
    cruce[k].porMes = s.porMes;
    cruce[k].ultima = s.ultima;
  });

  const ceros = salidas.mesesVenta.map(() => 0);
  const filas = Object.keys(cruce).map(k => cruce[k])
    .sort((a, b) => a.dep.localeCompare(b.dep, 'es') || b.qv - a.qv || b.qs - a.qs)
    .map(c => [c.ref, c.nombre, c.fam, c.dep, c.cat, c.qs, c.vs, c.qv, c.vv,
               c.porMes || ceros, c.ultima]);

  /* Resumen por depósito, para la hoja DEPOSITOS y el encabezado del reporte.
     Entran todos los depósitos de Odoo, también los vacíos: un gimnasio sin
     stock ni ventas es un dato, no un hueco. */
  const res = {};
  Object.keys(stock.depositos.info).forEach(d => {
    res[d] = { qs: 0, vs: 0, qv: 0, vv: 0, ultima: '' };
  });
  filas.forEach(f => {
    if (!res[f[3]]) res[f[3]] = { qs: 0, vs: 0, qv: 0, vv: 0, ultima: '' };
    const r = res[f[3]];
    r.qs += f[5]; r.vs += f[6]; r.qv += f[7]; r.vv += f[8];
    if (f[10] > r.ultima) r.ultima = f[10];
  });

  const depos = {};
  const resumen = Object.keys(res)
    .sort((a, b) => {
      const ia = stkInfoDeposito_(stock.depositos, a), ib = stkInfoDeposito_(stock.depositos, b);
      return stkOrdenGrupo_(ia.grupo) - stkOrdenGrupo_(ib.grupo) || res[b].vs - res[a].vs;
    })
    .map(d => {
      const i = stkInfoDeposito_(stock.depositos, d);
      depos[d] = { cod: i.cod, grupo: i.grupo, mues: i.mues, abas: i.abas, nc: i.nc };
      const r = res[d];
      return [d, i.cod, i.grupo, stkTipoDeposito_(i),
              Math.round(r.qs * 100) / 100, Math.round(r.vs),
              Math.round(r.qv * 100) / 100, Math.round(r.vv), r.ultima];
    });

  return { filas, resumen, depos };
}

/**
 * Canal de venta de cada cliente, deducido de su lista de precios.
 *
 * La lectura va con TODAS las empresas visibles en el contexto, no solo con
 * Vitalica. Odoo tiene una regla global sobre product.pricelist
 * —['|',('company_id','parent_of',company_ids),('company_id','=',False)]— y un
 * cliente al que alguien le asignó una lista de Camping 44 queda fuera de esa
 * regla: al pedir el nombre de su lista, Odoo corta la lectura entera con un
 * error de acceso. Abriendo el contexto se lee el nombre y listo; el reporte
 * sigue valorizando solo Vitalica, porque eso lo decide el resto del script.
 */
function stkCanales_(sesion, empresa) {
  const meta = stkCamposDe_(sesion, 'res.partner');
  const campo = meta.property_product_pricelist ? 'property_product_pricelist' : null;
  if (!campo) return {};

  const empresas = stkEjecutar_(sesion, 'res.company', 'search', [[]]) || [];
  const contexto = empresas.length ? { allowed_company_ids: empresas } : null;

  const socios = stkLeerTodo_(sesion, 'res.partner',
    [['customer_rank', '>', 0]], ['id', campo], 'id asc', contexto);

  const salida = {};
  socios.forEach(x => {
    const lista = stkNorm_(stkNombre_(x[campo]));
    if (!lista) return;
    for (let i = 0; i < STK.CANALES_POR_LISTA.length; i++) {
      if (STK.CANALES_POR_LISTA[i].claves.some(c => lista.indexOf(stkNorm_(c)) === 0)) {
        salida[x.id] = STK.CANALES_POR_LISTA[i].canal;
        return;
      }
    }
  });
  return salida;
}

/**
 * Canal de cada albarán, tomado del equipo de ventas del pedido que lo
 * originó.
 */
function stkCanalPorPedido_(sesion, idsAlbaran) {
  const meta = stkCamposDe_(sesion, 'stock.picking');
  if (!meta.sale_id) return {};

  const albaranes = [];
  stkLotes_(idsAlbaran, STK.LOTE_API).forEach(lote => {
    albaranes.push(...stkEjecutar_(sesion, 'stock.picking', 'read', [lote],
      { fields: ['id', 'sale_id'] }));
  });

  const idsPedido = Array.from(new Set(
    albaranes.map(a => stkId_(a.sale_id)).filter(Boolean)));
  if (!idsPedido.length) return {};

  const metaPedido = stkCamposDe_(sesion, 'sale.order');
  const campos = stkCamposQueExisten_(metaPedido, ['id', 'team_id']);
  const equipoPorPedido = {};
  stkLotes_(idsPedido, STK.LOTE_API).forEach(lote => {
    stkEjecutar_(sesion, 'sale.order', 'read', [lote], { fields: campos })
      .forEach(p => {
        const equipo = stkLimpiar_(stkNombre_(p.team_id));
        if (equipo) equipoPorPedido[p.id] = equipo;
      });
  });

  const salida = {};
  albaranes.forEach(a => {
    const equipo = equipoPorPedido[stkId_(a.sale_id)];
    if (!equipo) return;
    salida[a.id] = STK.CANALES_POR_EQUIPO[equipo] || equipo;
  });
  return salida;
}

/**
 * Odoo no guarda la foto del stock de un martes de noviembre; guarda cada
 * movimiento de valor. Entonces se parte del valor de hoy y se resta hacia
 * atrás: saldo(cierre de mes M) = valor actual − Σ movimientos posteriores.
 *
 * Las capas de valorización no guardan depósito: el histórico es de toda la
 * empresa, por familia y por artículo.
 */
function stkHistorico_(sesion, empresa, productos, valorPorFamilia, valorPorArticulo) {
  const meta = stkCamposDe_(sesion, 'stock.valuation.layer');
  const campoFecha = meta.create_date ? 'create_date' : 'date';

  /* Antes de la primera capa no hay historia: esos meses salían planos. El
     gráfico arranca en el primer mes con datos y crece solo hasta el tope. */
  const primera = stkEjecutar_(sesion, 'stock.valuation.layer', 'search_read',
    [[['company_id', '=', empresa.id]]], { fields: [campoFecha], limit: 1, order: `${campoFecha} asc` });
  let meses = STK.MESES_HISTORICO;
  if (primera.length) {
    const f = String(primera[0][campoFecha]);
    const hoy = new Date();
    const desde = (hoy.getFullYear() - Number(f.substring(0, 4))) * 12 +
                  (hoy.getMonth() + 1 - Number(f.substring(5, 7))) + 1;
    meses = Math.max(2, Math.min(STK.MESES_HISTORICO, desde));
  }
  const cierres = stkCierres_(meses);

  const capas = stkLeerTodo_(sesion, 'stock.valuation.layer', [
    ['company_id', '=', empresa.id],
    [campoFecha, '>=', `${cierres[0].inicio} 00:00:00`],
  ], ['id', 'product_id', 'value', campoFecha], `${campoFecha} asc`);

  const porArticuloMes = {};
  const porFamiliaMes = {};
  capas.forEach(capa => {
    const p = productos.porPlantilla[productos.plantillaPorVariante[stkId_(capa.product_id)]];
    if (!p) return;
    const mes = String(capa[campoFecha]).substring(0, 7);
    const valor = stkNum_(capa.value);

    const clave = p.referencia + '|' + p.nombre;
    if (!porArticuloMes[clave]) porArticuloMes[clave] = {};
    porArticuloMes[clave][mes] = (porArticuloMes[clave][mes] || 0) + valor;

    if (!porFamiliaMes[p.familia]) porFamiliaMes[p.familia] = {};
    porFamiliaMes[p.familia][mes] = (porFamiliaMes[p.familia][mes] || 0) + valor;
  });

  const serie = (saldoHoy, movimientos) => {
    const s = new Array(cierres.length);
    let saldo = saldoHoy || 0;
    for (let i = cierres.length - 1; i >= 0; i--) {
      s[i] = Math.round(Math.max(saldo, 0));
      saldo -= stkNum_(movimientos[cierres[i].mes]);
    }
    return s;
  };

  const filasFam = Object.keys(valorPorFamilia).sort()
    .map(fam => [fam].concat(serie(valorPorFamilia[fam], porFamiliaMes[fam] || {})));

  /* Por artículo, solo los de mayor valor, para no inflar el archivo. */
  const filasArt = Object.keys(valorPorArticulo)
    .sort((a, b) => valorPorArticulo[b] - valorPorArticulo[a])
    .slice(0, STK.TOP_SERIES_ARTICULO)
    .map(clave => [clave].concat(serie(valorPorArticulo[clave], porArticuloMes[clave] || {})));

  return { cierres, filasFam, filasArt };
}


/**
 * Compara las dos últimas corridas registradas y muestra qué cambió.
 */
function stkVerBitacora() {
  const hoja = stkSS_().getSheetByName(STK.HOJAS.BITACORA);
  if (!hoja || hoja.getLastRow() < 2) {
    stkAvisar_('Bitácora', 'Todavía no hay corridas registradas. Se registra una en cada actualización.');
    return;
  }
  stkSS_().setActiveSheet(hoja);

  const n = hoja.getLastRow();
  if (n < 3) {
    stkAvisar_('Bitácora', [
      'Hay una sola corrida registrada: no hay contra qué comparar.',
      'La comparación aparece a partir de la segunda.',
    ].join('\n'));
    return;
  }

  const titulos = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const previa = hoja.getRange(n - 1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const actual = hoja.getRange(n, 1, 1, hoja.getLastColumn()).getValues()[0];

  const gs = x => new Intl.NumberFormat('es-PY').format(Math.round(Math.abs(x)));
  const lineas = ['De: ' + previa[0], 'A:  ' + actual[0], ''];
  for (let i = 1; i < titulos.length; i++) {
    const dif = stkNum_(actual[i]) - stkNum_(previa[i]);
    if (Math.abs(dif) < 1) continue;
    lineas.push('  ' + titulos[i] + ': ' + (dif > 0 ? '+' : '-') + ' ' + gs(dif));
  }
  if (lineas.length === 3) lineas.push('  Sin diferencias.');
  lineas.push('', 'Registros guardados: ' + (n - 1) + ' (se conservan los últimos 400).');
  stkAvisar_('Bitácora de cambios', lineas.join('\n'));
}


/** Cantidades vendidas por canal, redondeadas, para el reporte. */
function stkCanalesDe_(porCanal) {
  const salida = {};
  Object.keys(porCanal || {}).forEach(c => {
    salida[c] = Math.round(porCanal[c].q * 100) / 100;
  });
  return salida;
}

/** Texto del aviso de fin: qué cambió desde la corrida anterior. */
function stkResumenCambio_(c) {
  const gs = n => new Intl.NumberFormat('es-PY').format(Math.round(Math.abs(n)));
  const signo = n => (n > 0 ? '+' : '-');
  const lineas = ['Cambios desde la corrida del ' + c.desde + ':',
                  '  Total: ' + signo(c.total) + ' Gs. ' + gs(c.total)];
  Object.keys(c.cambios)
    .filter(k => Math.abs(c.cambios[k]) >= 1000000)
    .sort((a, b) => Math.abs(c.cambios[b]) - Math.abs(c.cambios[a]))
    .forEach(k => {
      lineas.push('  ' + k + ': ' + signo(c.cambios[k]) + ' Gs. ' + gs(c.cambios[k]));
    });
  if (c.articulos) lineas.push('  Artículos: ' + signo(c.articulos) + Math.abs(c.articulos));
  lineas.push('', 'El detalle completo está en la hoja BITACORA.');
  return lineas.join('\n');
}

/**
 * Guarda una foto de los totales en cada corrida y devuelve la diferencia
 * contra la anterior. Sin esto, cuando un número cambia de un día para otro
 * no hay forma de saber si fue una venta, una recategorización o un ajuste.
 */
function stkBitacora_(stock) {
  const hoja = stkHoja_(STK.HOJAS.BITACORA);
  const titulos = ['Fecha y hora', 'Stock total (Gs.)', 'A (Gs.)', 'B (Gs.)', 'C (Gs.)',
                   'N (Gs.)', 'Sin categorizar (Gs.)', 'En muestrario (Gs.)', 'Unidades',
                   'Artículos por depósito', 'Familias'];
  const claves = ['A', 'B', 'C', 'N', 'NC'];

  /* stock.filas: [familia, depósito, grupo, tipo, categoría, cantidad, valor] */
  const t = { A: 0, B: 0, C: 0, N: 0, NC: 0 };
  let muestrario = 0, unidades = 0;
  const familias = {};
  stock.filas.forEach(f => {
    const cat = String(f[4]).trim().toUpperCase();
    if (t[cat] !== undefined) t[cat] += stkNum_(f[6]);
    if (f[3] === 'Muestrario') muestrario += stkNum_(f[6]);
    unidades += stkNum_(f[5]);
    familias[f[0]] = true;
  });
  const total = claves.reduce((x, k) => x + t[k], 0);

  const fila = [stkAhora_(), Math.round(total)]
    .concat(claves.map(k => Math.round(t[k])))
    .concat([Math.round(muestrario), Math.round(unidades), stock.articulos.length,
             Object.keys(familias).length]);

  let anterior = null;
  if (hoja.getLastRow() > 1) {
    const ultimas = hoja.getRange(hoja.getLastRow(), 1, 1, titulos.length).getValues()[0];
    if (ultimas[0]) anterior = ultimas;
  }

  if (hoja.getLastRow() < 1) {
    hoja.getRange(1, 1, 1, titulos.length).setValues([titulos]);
    hoja.getRange(1, 1, 1, titulos.length)
      .setBackground('#525252').setFontColor('#FFFFFF').setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  hoja.appendRow(fila);
  hoja.getRange(hoja.getLastRow(), 2, 1, titulos.length - 1).setNumberFormat('#,##0');

  /* Solo se conservan las últimas 400 corridas. */
  if (hoja.getLastRow() > 401) hoja.deleteRows(2, hoja.getLastRow() - 401);

  if (!anterior) return null;
  const cambios = {};
  claves.forEach((k, i) => { cambios[k] = Math.round(t[k] - stkNum_(anterior[i + 2])); });
  return {
    desde: String(anterior[0]),
    total: Math.round(total - stkNum_(anterior[1])),
    cambios: cambios,
    articulos: stock.articulos.length - stkNum_(anterior[9]),
  };
}


/* ==========================================================================
   4. PUBLICAR
   ========================================================================== */

/**
 * Sube datos.js al repositorio, con los datos armados en memoria por
 * stkActualizarDatos. No hay publicación "desde las hojas": Sheets convierte
 * textos en fechas y releerlas corrompe los datos.
 */
function stkPublicar(datos) {
  if (!datos || !datos.STOCK) {
    throw new Error('No hay datos para publicar. Usá "3. Actualizar y publicar".');
  }
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('Falta GITHUB_TOKEN en las propiedades del script.');
  }
  const contenido =
    `/* Generado desde la planilla el ${stkAhora_()}.\n` +
    '   No editar a mano: la próxima publicación lo sobrescribe. */\n\n' +
    `var DATOS = ${JSON.stringify(datos)};\n`;

  const url = `https://api.github.com/repos/${STK.GITHUB_OWNER}/${STK.GITHUB_REPO}/contents/${STK.GITHUB_ARCHIVO}`;
  const cab = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

  let sha = null;
  const actual = UrlFetchApp.fetch(`${url}?ref=${STK.GITHUB_RAMA}`, { headers: cab, muteHttpExceptions: true });
  if (actual.getResponseCode() === 200) sha = JSON.parse(actual.getContentText()).sha;
  else if (actual.getResponseCode() !== 404) {
    throw new Error(`GitHub respondió ${actual.getResponseCode()}: ${actual.getContentText().substring(0, 400)}`);
  }

  const cuerpo = {
    message: `Actualización de datos — ${stkAhora_()}`,
    content: Utilities.base64Encode(contenido, Utilities.Charset.UTF_8),
    branch: STK.GITHUB_RAMA,
  };
  if (sha) cuerpo.sha = sha;

  const r = UrlFetchApp.fetch(url, {
    method: 'put', headers: cab, contentType: 'application/json',
    payload: JSON.stringify(cuerpo), muteHttpExceptions: true,
  });
  if (r.getResponseCode() >= 300) {
    throw new Error(`No se pudo publicar (${r.getResponseCode()}): ${r.getContentText().substring(0, 400)}`);
  }
  stkAvisar_('Publicado',
    [
      `${new Set(datos.STOCK.map(x => x.fam)).size} familias`,
      `${Object.keys(datos.DEPOS || {}).length} depósitos`,
      '',
      `Subido a ${STK.GITHUB_OWNER}/${STK.GITHUB_REPO}.`,
    ].join('\n'));
}


const STK_CATS = [
  { k: 'A',  lab: 'A – Potenciar',   col: 'var(--A)',    raw: '#2F7D4F' },
  { k: 'B',  lab: 'B – Mantener',    col: 'var(--B)',    raw: '#B8921B' },
  { k: 'C',  lab: 'C – Liquidar',    col: 'var(--C)',    raw: '#C0392B' },
  { k: 'N',  lab: 'N – Nuevo',       col: 'var(--N)',    raw: '#3D6E8C' },
  { k: 'NC', lab: 'Sin categorizar', col: 'url(#hatch)', raw: '#8C7A57' },
];


/* ==========================================================================
   ACTUALIZACIÓN AUTOMÁTICA
   ==========================================================================
   El reporte no se consulta en vivo: los datos son los de la última
   extracción, y la fecha figura arriba en "DATOS AL". Con esto se programa
   una corrida diaria de madrugada.
   ========================================================================== */

const STK_HORA_ACTUALIZACION = 6;   /* madrugada, hora de Paraguay */

/** Extrae de Odoo y publica, en un solo paso. Apto para disparador. */
function stkAutomatico() {
  const inicio = new Date();
  try {
    const datos = stkActualizarDatos();
    if (!datos) throw new Error('Otra ejecución estaba en curso: no se publicó nada.');
    stkPublicar(datos);
    PropertiesService.getScriptProperties()
      .setProperty('STK_ULTIMA_CORRIDA', `${stkAhora_()} · OK`);
    Logger.log(`Actualización completa en ${Math.round((new Date() - inicio)/1000)} s.`);
  } catch (error) {
    const mensaje = error && error.message ? error.message : String(error);
    PropertiesService.getScriptProperties()
      .setProperty('STK_ULTIMA_CORRIDA', `${stkAhora_()} · ERROR: ${mensaje.substring(0, 200)}`);
    Logger.log(`FALLÓ: ${mensaje}`);

    /* Sin aviso, una corrida que falla de madrugada pasa desapercibida y el
       reporte queda con datos viejos sin que nadie lo note. */
    const correo = PropertiesService.getScriptProperties().getProperty('STK_AVISAR_A');
    if (correo) {
      try {
        MailApp.sendEmail(correo,
          'Reporte de Stock Vitalica — falló la actualización automática',
          ['La actualización de las ' + String(STK_HORA_ACTUALIZACION).padStart(2, '0') + ':00 no se completó.',
           '',
           'Motivo: ' + mensaje,
           '',
           'El reporte publicado sigue con los últimos datos buenos.',
           'Se puede reintentar a mano desde la planilla:',
           'Reporte de Stock → 3. Actualizar y publicar.',
          ].join('\n'));
      } catch (e) { Logger.log('No se pudo enviar el aviso: ' + e); }
    }
    throw error;   /* que quede registrado en el panel de ejecuciones */
  }
}

function stkProgramar() {
  const id = stkSS_().getId();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
  stkQuitarDisparadores_();
  ScriptApp.newTrigger('stkAutomatico')
    .timeBased()
    .atHour(STK_HORA_ACTUALIZACION)
    .everyDays(1)
    .inTimezone(STK.ZONA_HORARIA)
    .create();
  const correo = PropertiesService.getScriptProperties().getProperty('STK_AVISAR_A');
  stkAvisar_('Actualización programada', [
    `Todos los días alrededor de las ${String(STK_HORA_ACTUALIZACION).padStart(2, '0')}:00.`,
    '',
    'Extrae de Odoo y publica el reporte, en ese orden.',
    'Si falla, no publica nada: el reporte queda con los últimos datos buenos.',
    '',
    correo
      ? 'Si falla, se avisa por correo a: ' + correo
      : 'Para recibir aviso cuando falle, agregá la propiedad STK_AVISAR_A ' +
        'con tu correo en Configuración del proyecto.',
    '',
    'Google puede correrlo hasta una hora antes o después. Es normal.',
  ].join('\n'));
}

function stkCancelarProgramacion() {
  const cantidad = stkQuitarDisparadores_();
  stkAvisar_('Actualización automática',
    cantidad ? 'Programación cancelada.' : 'No había ninguna programación activa.');
}

function stkQuitarDisparadores_() {
  let cantidad = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'stkAutomatico') { ScriptApp.deleteTrigger(t); cantidad += 1; }
  });
  return cantidad;
}

function stkEstadoProgramacion() {
  const activos = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'stkAutomatico').length;
  const ultima = PropertiesService.getScriptProperties().getProperty('STK_ULTIMA_CORRIDA');
  stkAvisar_('Estado de la actualización', [
    `Programación: ${activos ? 'ACTIVA' : 'inactiva'}`,
    `Hora prevista: ${String(STK_HORA_ACTUALIZACION).padStart(2, '0')}:00 (${STK.ZONA_HORARIA})`,
    `Última corrida: ${ultima || 'sin registro'}`,
    `Aviso por correo: ${PropertiesService.getScriptProperties().getProperty('STK_AVISAR_A') || 'no configurado'}`,
  ].join('\n'));
}


/* ==========================================================================
   UTILIDADES
   ========================================================================== */

function stkHoja_(nombre) {
  const ss = stkSS_();
  return ss.getSheetByName(nombre) || ss.insertSheet(nombre);
}

function stkEscribir_(nombre, titulos, filas, columnasNumericas) {
  const h = stkHoja_(nombre);
  if (h.getFilter()) h.getFilter().remove();
  h.setConditionalFormatRules([]);
  h.clear();

  /* Formato TEXTO en todo lo que no sea número, ANTES de escribir.
     Si no, Google Sheets convierte textos como "5.11" o "30-06" en fechas. */
  const numericas = columnasNumericas || [];
  const filasFormato = Math.max(h.getMaxRows(), filas.length + 1);
  for (let col = 1; col <= titulos.length; col++) {
    if (numericas.indexOf(col) < 0) h.getRange(1, col, filasFormato, 1).setNumberFormat('@');
  }

  h.getRange(1, 1, 1, titulos.length).setValues([titulos]);
  if (filas.length) {
    h.getRange(2, 1, filas.length, titulos.length).setValues(filas);
    numericas.forEach(c => h.getRange(2, c, filas.length, 1).setNumberFormat('#,##0'));
    h.getRange(1, 1, filas.length + 1, titulos.length).createFilter();
  }
  h.getRange(1, 1, 1, titulos.length)
    .setBackground('#525252').setFontColor('#FFFFFF').setFontWeight('bold').setWrap(true);
  h.setFrozenRows(1);
  h.autoResizeColumns(1, titulos.length);
}

function stkVisible_(metaCampo, valor) {
  if (!metaCampo || !valor) return '';
  if (metaCampo.type === 'selection' && Array.isArray(metaCampo.selection)) {
    const par = metaCampo.selection.filter(p => p[0] === valor)[0];
    return par ? par[1] : valor;
  }
  if (Array.isArray(valor)) return valor[1] || '';
  return valor;
}

function stkMesesAtras_(meses) {
  const hoy = new Date();
  return Utilities.formatDate(
    new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth() - meses, 1, 12)), 'UTC', 'yyyy-MM-dd');
}

function stkCierres_(cantidad) {
  const nombres = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const hoy = new Date();
  const salida = [];
  for (let i = cantidad - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth() - i, 1, 12));
    const anio = d.getUTCFullYear();
    const mes = d.getUTCMonth();
    salida.push({
      mes: `${anio}-${String(mes + 1).padStart(2, '0')}`,
      inicio: `${anio}-${String(mes + 1).padStart(2, '0')}-01`,
      etiqueta: (i === cantidad - 1 || mes === 0) ? `${nombres[mes]} ${String(anio).slice(-2)}` : nombres[mes],
    });
  }
  return salida;
}

function stkLotes_(items, tamano) {
  const lotes = [];
  for (let i = 0; i < items.length; i += tamano) lotes.push(items.slice(i, i + tamano));
  return lotes;
}

function stkAhora_() {
  return Utilities.formatDate(new Date(), STK.ZONA_HORARIA, 'dd/MM/yyyy HH:mm');
}

function stkId_(v) { return Array.isArray(v) ? v[0] : (v || ''); }
function stkNombre_(v) { return Array.isArray(v) ? v[1] : ''; }
function stkNum_(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
/** Una fecha acá significa que Sheets convirtió un texto: se avisa, no se adivina. */
function stkTexto_(v) {
  if (v instanceof Date) return 'REVISAR FORMATO';
  return String(v === null || v === undefined ? '' : v).trim();
}

function stkNorm_(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function stkError_(titulo, error) {
  const m = error && error.message ? error.message : String(error);
  console.error(error && error.stack ? error.stack : error);
  /* La traza va también al cuadro de diálogo: con el mensaje solo, un error de
     programación no dice en qué paso se cortó y hay que adivinar. */
  const traza = (error && error.stack ? String(error.stack) : '')
    .split('\n').slice(0, 6).join('\n');
  const cuerpo = traza ? m + '\n\nDónde:\n' + traza : m;
  stkAvisar_(titulo, cuerpo.substring(0, 3000));
}


/* ==========================================================================
   COMPATIBILIDAD DE CONTEXTO
   ==========================================================================
   getUi() solo existe cuando la ejecución tiene una planilla adelante. Desde
   el editor o desde un disparador no existe y tirar una alerta rompe todo.
   Entonces: si hay interfaz se muestra la ventana, y si no, el mismo texto va
   al registro de ejecución.
   ========================================================================== */

/* Permisos de Odoo que faltaron en esta corrida. El canal de venta y otros
   datos accesorios dependen de modelos que el usuario del script puede no
   tener habilitados; cuando eso pasa conviene seguir sin ese dato y avisarlo,
   y no perder el reporte entero por una columna. */
var STK_SIN_PERMISO = [];

/**
 * Corre una lectura opcional. Si Odoo la rechaza por permisos, devuelve el
 * valor de reserva y deja anotado qué faltó.
 */
function stkOpcional_(queEs, fn, reserva) {
  try {
    return fn();
  } catch (error) {
    const texto = String((error && error.message) || error);
    const esPermiso = /acces|permis|restringid|restricted|not allowed|AccessError/i.test(texto);
    if (!esPermiso) throw error;
    const modelo = (texto.match(/\(([a-z_.]+)\)/) || [])[1] || '';
    STK_SIN_PERMISO.push(queEs + (modelo ? ' — falta leer ' + modelo : ''));
    Logger.log('Sin permiso para ' + queEs + ': ' + texto);
    return reserva;
  }
}

/** Avisa por ventana si se puede; si no, al registro. Nunca corta la ejecución. */
function stkAvisar_(titulo, cuerpo) {
  const texto = String(cuerpo);
  Logger.log(`=== ${titulo} ===\n${texto}`);
  try {
    SpreadsheetApp.getUi().alert(titulo, texto, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (sinInterfaz) {
    /* Sin interfaz disponible. El registro ya tiene el mensaje. */
  }
}

/** Aviso corto en la planilla. Silencioso si no hay contexto. */
function stkToast_(mensaje) {
  try { stkSS_().toast(mensaje, 'Reporte de Stock', 8); } catch (e) {}
}

/**
 * La planilla de trabajo. Si el proyecto no está vinculado a ninguna, se usa
 * la propiedad SPREADSHEET_ID.
 */
function stkSS_() {
  const activa = SpreadsheetApp.getActiveSpreadsheet();
  if (activa) return activa;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error(
      'Este proyecto no está vinculado a ninguna planilla.\n\n' +
      'Opción 1 (recomendada): abrí la planilla y entrá por Extensiones → Apps Script.\n' +
      'Opción 2: agregá la propiedad SPREADSHEET_ID con el id de la planilla ' +
      '(está en la URL, entre /d/ y /edit).'
    );
  }
  return SpreadsheetApp.openById(id);
}
