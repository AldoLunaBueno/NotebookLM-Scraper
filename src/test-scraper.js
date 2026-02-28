import { chromium } from 'playwright';
import 'dotenv/config';

async function testScraping() {
    // 1. Usamos un contexto persistente. 
    // Esto crea una carpeta local para guardar tus cookies, así solo inicias sesión en Google una vez.
    const userDataDir = './perfil_chrome_test';
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome', // ¡La clave! Esto obliga a usar tu Google Chrome real instalado en el sistema
        args: [
            '--disable-blink-features=AutomationControlled', // Oculta la bandera de "navegador automatizado"
            '--no-default-browser-check',
            '--no-first-run'
        ]
    });

    const page = await browser.newPage();
    
    // ⚠️ REEMPLAZA ESTO con la URL de tu cuaderno real de NotebookLM
    // 'https://notebooklm.google.com/notebook/TU_ID_AQUI'
    const NOTEBOOK_URL = process.env.NLM_NOTEBOOK_URL; 
    
    console.log('🌐 Navegando a NotebookLM...');
    await page.goto(NOTEBOOK_URL);

    // 2. Esperar al input del chat (Selector extraído de browser-session.ts)
    const inputSelector = 'textarea.query-box-input';
    
    console.log('⏳ Esperando a que cargue la interfaz...');
    console.log('💡 Si es tu primera vez, inicia sesión en Google en la ventana del navegador. El script esperará.');
    
    // Timeout en 0 significa que esperará indefinidamente hasta que te loguees y cargue el cuaderno
    await page.waitForSelector(inputSelector, { state: 'visible', timeout: 0 });
    console.log('✅ Interfaz lista.');

    // 3. Hacer la pregunta
    const pregunta = 'Hazme un resumen muy breve de los documentos.';
    console.log(`💬 Preguntando: "${pregunta}"`);
    await page.fill(inputSelector, pregunta);
    await page.keyboard.press('Enter');

    // 4. Extraer la respuesta (Lógica simplificada de page-utils.ts)
    console.log('⏳ Esperando la respuesta de la IA...');
    
    // Damos un tiempo arbitrario para que termine de generar (en el MCP real usan un polling complejo)
    // Para la prueba, 15 segundos deberían bastar para una respuesta corta.
    await page.waitForTimeout(15000); 

    // --- PARTE 1: Extraer y limpiar el texto principal ---
    const textoPrincipal = await page.evaluate(() => {
        const containers = document.querySelectorAll('.to-user-container');
        if (containers.length === 0) return "No se encontraron contenedores de respuesta.";

        // Tomamos el último contenedor (la respuesta más reciente)
        const ultimoContenedor = containers[containers.length - 1];
        const textElement = ultimoContenedor.querySelector('.message-text-content');
        if (!textElement) return "Sin texto.";

        // Clonamos el elemento para no dañar la página visualmente
        const clone = textElement.cloneNode(true);
        
        // Buscamos todas las burbujas y las reemplazamos por el formato [1], [2], etc.
        const markers = clone.querySelectorAll('button.citation-marker');
        markers.forEach(marker => {
            const numero = marker.innerText.trim();
            const textoLimpio = document.createTextNode(` [${numero}]`);
            marker.parentNode.replaceChild(textoLimpio, marker);
        });

        return clone.innerText.trim();
    });

    // --- PARTE 2: Interactuar con las burbujas para extraer los fragmentos ---
    console.log('🔍 Extrayendo citas referenciadas...');
    const referencias = [];
    
    const ultimoContenedor = page.locator('.to-user-container').last();
    const marcadores = await ultimoContenedor.locator('button.citation-marker').all();

    for (let i = 0; i < marcadores.length; i++) {
        console.log(`   Procesando cita [${i + 1}/${marcadores.length}]...`);
        
        // 1. Aseguramos que el botón esté en pantalla y hacemos un hover previo (ayuda a Angular)
        await marcadores[i].scrollIntoViewIfNeeded();
        await marcadores[i].hover();
        await page.waitForTimeout(200); // Pequeña pausa humana
        await marcadores[i].click();
        
        // 2. Esperamos al popup. Usamos .last() por si Angular deja tooltips fantasmas en el DOM
        const tooltipTextLocator = page.locator('.citation-tooltip-text').last();
        
        try {
            await tooltipTextLocator.waitFor({ state: 'visible', timeout: 4000 });
        } catch (error) {
            console.log(`   ⚠️ Reintentando clic en la cita [${i + 1}]...`);
            // Si falló (ej. por cambiar de ventana), volvemos a hacer clic
            await marcadores[i].click();
            await tooltipTextLocator.waitFor({ state: 'visible', timeout: 4000 });
        }
        
        // 3. Extraemos la información
        const fragmento = await tooltipTextLocator.innerText();
        const fuente = await page.locator('.citation-tooltip-footer').last().innerText();
        
        referencias.push({
            indice: i + 1,
            fuente: fuente.trim(),
            fragmento: fragmento.trim()
        });

        // 4. Cerramos el popup y esperamos a que desaparezca del DOM
        await page.keyboard.press('Escape');
        await tooltipTextLocator.waitFor({ state: 'hidden', timeout: 3000 });
        await page.waitForTimeout(300); // Margen de seguridad para la animación
    }

    // --- PARTE 3: Ensamblar el JSON final ---
    const resultadoFinal = {
        pregunta: pregunta,
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