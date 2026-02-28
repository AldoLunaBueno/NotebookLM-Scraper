import { chromium } from 'playwright';
import 'dotenv/config';

async function testScraping() {
    // 1. Usamos un contexto persistente. 
    // Esto crea una carpeta local para guardar tus cookies, así solo inicias sesión en Google una vez.
    const userDataDir = './perfil_chrome_test';
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-default-browser-check',
            '--no-first-run'
        ]
    });

    const page = await browser.newPage();
    const NOTEBOOK_URL = process.env.NLM_NOTEBOOK_URL; 
    
    // 🎛️ --- CONTROL DE FLUJO ---
    const ENVIAR_NUEVA_PREGUNTA = false; 
    const pregunta = 'Hazme un resumen muy breve de los documentos.';

    console.log('🌐 Navegando a NotebookLM...');
    await page.goto(NOTEBOOK_URL);

    const inputSelector = 'textarea.query-box-input';
    console.log('⏳ Esperando a que cargue la interfaz...');
    await page.waitForSelector(inputSelector, { state: 'visible', timeout: 0 });
    console.log('✅ Interfaz lista.');

    if (ENVIAR_NUEVA_PREGUNTA) {
        console.log(`💬 Preguntando: "${pregunta}"`);
        await page.fill(inputSelector, pregunta);
        await page.keyboard.press('Enter');
        console.log('⏳ Esperando la respuesta de la IA (15 segundos)...');
        await page.waitForTimeout(15000); 
    } else {
        console.log('⏭️ Omitiendo nueva consulta. Usando el historial existente...');
        await page.waitForSelector('.to-user-container', { state: 'visible' });
        await page.waitForTimeout(2000); 
    }

    const ultimoContenedor = page.locator('.to-user-container').last();

    // 🚀 --- NUEVO: FASE DE EXPANSIÓN ---
    console.log('🔍 Buscando citas agrupadas para expandir...');
    // Buscamos todos los marcadores en el último contenedor
    const posiblesExpansores = await ultimoContenedor.locator('button.citation-marker').all();
    
    for (const expansor of posiblesExpansores) {
        const textoExpansor = await expansor.innerText();
        if (textoExpansor.trim() === '...') {
            console.log('   🔄 Expandiendo grupo de citas ocultas...');
            await expansor.scrollIntoViewIfNeeded();
            await expansor.click();
            await page.waitForTimeout(800); // Esperamos a que la animación revele los botones
        }
    }

    // --- PARTE 1: Extraer y limpiar el texto principal ---
    const textoPrincipal = await page.evaluate(() => {
        const containers = document.querySelectorAll('.to-user-container');
        if (containers.length === 0) return "No se encontraron contenedores de respuesta.";

        const ultimoContenedorDOM = containers[containers.length - 1];
        const textElement = ultimoContenedorDOM.querySelector('.message-text-content');
        if (!textElement) return "Sin texto.";

        // Clonamos el elemento para no dañar la página visualmente
        const clone = textElement.cloneNode(true);
        
        // Buscamos todas las burbujas y las reemplazamos por el formato [1], [2], etc.
        const markers = clone.querySelectorAll('button.citation-marker');
        markers.forEach(marker => {
            const texto = marker.innerText.trim();
            // Ignoramos los botones de control para que no ensucien el texto
            if (texto === '...' || texto === '><' || texto === '> <') {
                marker.remove();
            } else {
                const textoLimpio = document.createTextNode(` [${texto}]`);
                marker.parentNode.replaceChild(textoLimpio, marker);
            }
        });

        return clone.innerText.trim();
    });

    // --- PARTE 2: Interactuar con las burbujas para extraer los fragmentos ---
    console.log('\n🔍 Recopilando citas referenciadas reales (vía Hover)...');
    const referencias = [];
    
    // Volvemos a capturar todos los botones ahora que están expandidos
    const todosLosMarcadores = await ultimoContenedor.locator('button.citation-marker').all();
    const marcadoresValidos = [];

    // Filtramos para quedarnos solo con los números
    for (const marker of todosLosMarcadores) {
        const text = await marker.innerText();
        const textoLimpio = text.trim();
        if (textoLimpio !== '...' && textoLimpio !== '><' && textoLimpio !== '> <') {
            marcadoresValidos.push(marker);
        }
    }

    console.log(`   Se encontraron ${marcadoresValidos.length} citas para procesar.`);

    for (let i = 0; i < marcadoresValidos.length; i++) {
        console.log(`   Procesando cita [${i + 1}/${marcadoresValidos.length}]...`);
        
        const marcador = marcadoresValidos[i];

        // 1. Aseguramos que el botón esté en pantalla y hacemos un hover previo (ayuda a Angular)
        await marcador.scrollIntoViewIfNeeded();
        
        // Usamos hover en lugar de click
        await marcador.hover();
        
        // Contenedor global del tooltip
        const tooltipLocator = page.locator('xap-dialog-layout.citation-tooltip').last();
        const tooltipTextLocator = tooltipLocator.locator('.citation-tooltip-text');
        
        try {
            await tooltipLocator.waitFor({ state: 'visible', timeout: 4000 });
        } catch (error) {
            console.log(`   ⚠️ Reintentando hover en la cita [${i + 1}]...`);
            // Para "reiniciar" el hover, movemos el mouse lejos y volvemos
            await page.mouse.move(0, 0); 
            await page.waitForTimeout(200);
            await marcador.hover();
            await tooltipLocator.waitFor({ state: 'visible', timeout: 4000 });
        }
        
        // Pausa diminuta para que Angular inyecte el contenido
        await page.waitForTimeout(300);

        // Extraer texto
        let fragmento = await tooltipTextLocator.innerText();
        
        // 🖼️ VALIDACIÓN DE IMAGEN: Si el texto está vacío, verificamos si hay una etiqueta <img>
        if (!fragmento || fragmento.trim() === '') {
            const hasImage = await tooltipTextLocator.locator('img').count() > 0;
            if (hasImage) {
                fragmento = "[Imagen]";
            } else {
                fragmento = "[Fragmento vacío o no detectado]";
            }
        }

        const fuente = await tooltipLocator.locator('.citation-tooltip-footer').innerText();
        
        referencias.push({
            indice: i + 1,
            fuente: fuente.trim(),
            fragmento: fragmento.trim()
        });

        // 🚀 Cerrar el popup moviendo el mouse a la esquina superior izquierda (coordenada 0,0)
        await page.mouse.move(0, 0);
        await tooltipLocator.waitFor({ state: 'hidden', timeout: 3000 });
    }

    // --- PARTE 3: Ensamblar el JSON final ---
    const resultadoFinal = {
        pregunta: ENVIAR_NUEVA_PREGUNTA ? pregunta : "Respuesta extraída del historial",
        respuesta: textoPrincipal,
        citas: referencias
    };

    console.log('\n--- 📦 RESULTADO ESTRUCTURADO (JSON) ---');
    console.log(JSON.stringify(resultadoFinal, null, 2));
    console.log('----------------------------------------\n');

    console.log('🛑 Cerrando navegador...');
    await browser.close();
}

testScraping().catch(console.error);