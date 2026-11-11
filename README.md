# Reporte de Stock y Rotación — Vitalica

Versión Vitalica del reporte de Camping 44. Tres piezas:

- **`reporte-stock-stk.gs`** — Apps Script sobre una planilla. Lee Odoo 17 por
  JSON-RPC (solo lectura), escribe hojas de trabajo y publica `datos.js` en
  este repo por la Contents API.
- **`datos.js`** — lo genera el script. No editar a mano.
- **`index.html`** — el reporte. Lee `datos.js` del mismo directorio. Sin
  dependencias ni build.

## Qué cambia respecto de Camping 44

| | Camping 44 | Vitalica |
|---|---|---|
| Valorización | cantidad × costo de la ficha | valor de `stock.quant` (`STK.VALORIZAR_CON`) |
| Eje | marca | familia (categoría de producto) |
| Material controlado | Eje 1, ARM/MUN/CARG/ACC | no existe: A, B, C, N y sin categorizar |
| Sección principal | KPIs y marcas | **por depósito**, con rotación por gimnasio |

Se conservan sin cambios el `datos.js?v=<hora>` del cargador, el estado en el
hash de la URL, `.hero > * { min-width: 0 }`, la publicación desde memoria, la
lectura de listas de precios con las dos empresas en el contexto y
`stkOpcional_`.

## Montaje

1. Planilla nueva en Drive, por ejemplo "Rotación ABC Vitalica".
2. Extensiones → Apps Script. Pegar `reporte-stock-stk.gs`.
3. Configuración del proyecto → Propiedades del script:
   `ODOO_URL`, `ODOO_DB`, `ODOO_LOGIN`, `ODOO_API_KEY`, `GITHUB_TOKEN`
   y, opcional, `STK_AVISAR_A` (correo si falla la corrida automática).
4. Subir el logo como **`logo-vitalica.png`** a la raíz de este repo. Sin él,
   el reporte muestra una "V".
5. Settings → Pages → rama `main`, carpeta raíz.
6. Ejecutar `stkInstalarMenu()` una vez y recargar la planilla.
7. **1. Diagnosticar Odoo**: confirma empresa, campos, costos cargados y que
   los códigos de almacén coincidan con `STK.GRUPOS_DEPOSITO`. Ver la hoja
   DIAGNOSTICO DEPOSITOS.
8. **Detectar desvíos de valorización**: revisa que el valor de `stock.quant`
   cuadre con las capas antes de dar por buena la cifra.
9. **2. Detectar marcas**: tiene que dar cero.
10. **3. Actualizar y publicar**, y después **Programar actualización diaria**.

## Pendientes de definir

- **Valorización.** Confirmar con Gerencia que `stock.quant.value` es la cifra
  buena. Si se cargan costos, pasar `VALORIZAR_CON` a `'costo'`.
- **Consignación.** `DEPOSITOS_CONSIGNACION` trae los gimnasios. Si no es
  consignación, vaciar la lista.
- **Canales.** `CANALES_POR_LISTA` es un mapeo provisorio. En particular,
  revisar `CONGS`: en Camping 44 es consumidor final; acá quedó en Distribución.
- **Norma.** `STK.NORMA` está vacío hasta confirmar si el MP-MIS-01 aplica a
  Vitalica.
- **Repo público.** Se decidió dejarlo público: `datos.js` expone stock,
  valores por depósito y nombres de productos.

## Configuración sin tocar el código

Lo que cambia con el negocio vive en **`config.json`**, en la raíz de este
repo. El script lo lee en cada corrida: lo que se cambie ahí vale desde la
próxima actualización, **sin volver a pegar el código en Apps Script**.

- Grupos de depósitos por código de almacén (`GRUPOS_DEPOSITO`).
- Gimnasios que son muestrario (`DEPOSITOS_MUESTRARIO`).
- Depósitos de abastecimiento, como Megalog (`DEPOSITOS_ABASTECIMIENTO`).
- Ubicaciones no comerciales (`DEPOSITOS_NO_COMERCIALES`).
- Familias unificadas, categorías excluidas, canales, umbrales de cobertura,
  valorización y meses de histórico.

Ejemplo: cuando aparece un gimnasio nuevo en Odoo, se agrega su código al grupo
que corresponda en `GRUPOS_DEPOSITO` y, si es muestrario, a
`DEPOSITOS_MUESTRARIO`.

La empresa, la conexión con Odoo y la publicación **no** se pueden cambiar
desde ese archivo. Si falta o tiene un error, el script usa los valores
escritos en el código y lo avisa al terminar la corrida, en la línea
"Configuración". El diagnóstico muestra lo mismo en la hoja DIAGNOSTICO.
