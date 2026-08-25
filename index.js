( function ()
{
    "use strict";

    // ============================================================
    // 🔧 وضع الاختبار السريع: خليها true عشان كل ثانيتين حقيقيتين
    // تتحسب دقيقة واحدة جوه التايمر (يعني تجرب المراحل بسرعة)
    // خليها false للاستخدام العادي.
    // ============================================================
    const DEBUG_FAST_MODE = false;
    const FAST_SECONDS_PER_TICK = 3600; // ثانيتين تيك × 30 = 60 ثانية (دقيقة)

    const STORAGE_KEY = "gardenTimerState_v1";
    const CELL_COUNT = 363;
    const HOUR = 3600;
    const BASE_THRESHOLD = 6 * HOUR;
    const MIN_THRESHOLD = 1 * HOUR;

    function defaultState ()
    {
        return {
            elapsed: 0,
            isRunning: false,
            reductionHours: 0,
            nextMilestone: BASE_THRESHOLD,
            points: 0,
            totalPointsEarned: 0,
            smallTreesPlanted: 0,
            sinceLastBig: 0,
            bigCharges: 0,
            bigTreesPlanted: 0,
            garden: new Array( CELL_COUNT ).fill( null ),
            lastSavedAt: Date.now()
        };
    }

    function threshold ( state )
    {
        return Math.max( MIN_THRESHOLD, BASE_THRESHOLD - state.reductionHours * HOUR );
    }

    function loadStateFromLocalStorage ()
    {
        try
        {
            const raw = localStorage.getItem( STORAGE_KEY );
            if ( !raw ) return null;
            const parsed = JSON.parse( raw );
            if ( !parsed || !Array.isArray( parsed.garden ) ) return null;
            if ( parsed.garden.length !== CELL_COUNT )
            {
                const g = new Array( CELL_COUNT ).fill( null );
                for ( let i = 0; i < Math.min( g.length, parsed.garden.length ); i++ ) g[ i ] = parsed.garden[ i ];
                parsed.garden = g;
            }
            return parsed;
        } catch ( e ) { return null; }
    }

    let state = loadStateFromLocalStorage() || defaultState();
    let intervalId = null;
    let fileHandle = null; // real JSON file on disk, when linked via File System Access API

    // ---------- persistence ----------
    function persistLocal ()
    {
        state.lastSavedAt = Date.now();
        try { localStorage.setItem( STORAGE_KEY, JSON.stringify( state ) ); } catch ( e ) { }
    }

    async function persistToFile ()
    {
        if ( !fileHandle ) return;
        try
        {
            const writable = await fileHandle.createWritable();
            await writable.write( JSON.stringify( state, null, 2 ) );
            await writable.close();
        } catch ( e )
        {
            showToast( "مقدرتش أكتب في الملف — اتأكد إنك سامح بالصلاحية." );
        }
    }

    function saveState ()
    {
        persistLocal();
        if ( fileHandle ) persistToFile();
    }

    // ---------- DOM refs ----------
    const timeDisplay = document.getElementById( "timeDisplay" );
    const goalText = document.getElementById( "goalText" );
    const goalTextStat = document.getElementById( "goalTextStat" );
    const dialTree = document.getElementById( "dialTree" );
    const miniBarFill = document.getElementById( "miniBarFill" );
    const startBtn = document.getElementById( "startBtn" );
    const resetBtn = document.getElementById( "resetBtn" );
    const pointsStat = document.getElementById( "pointsStat" );
    const treesStat = document.getElementById( "treesStat" );
    const bigStat = document.getElementById( "bigStat" );
    const progressBigStat = document.getElementById( "progressBigStat" );
    const lastProgressLine = document.getElementById( "lastProgressLine" );
    const gardenGrid = document.getElementById( "gardenGrid" );
    const bigModeBtn = document.getElementById( "bigModeBtn" );
    const bigChargeCount = document.getElementById( "bigChargeCount" );
    const toast = document.getElementById( "toast" );
    const fastBadge = document.getElementById( "fastBadge" );

    const saveStatus = document.getElementById( "saveStatus" );
    const linkFileBtn = document.getElementById( "linkFileBtn" );
    const downloadBtn = document.getElementById( "downloadBtn" );
    const importBtn = document.getElementById( "importBtn" );
    const importInput = document.getElementById( "importInput" );

    const resumeOverlay = document.getElementById( "resumeOverlay" );
    const resumeText = document.getElementById( "resumeText" );
    const resumeContinueBtn = document.getElementById( "resumeContinueBtn" );
    const resumeRestartBtn = document.getElementById( "resumeRestartBtn" );

    const milestoneOverlay = document.getElementById( "milestoneOverlay" );
    const milestoneText = document.getElementById( "milestoneText" );
    const milestoneContinueBtn = document.getElementById( "milestoneContinueBtn" );
    const milestoneRestartBtn = document.getElementById( "milestoneRestartBtn" );

    const confirmResetOverlay = document.getElementById( "confirmResetOverlay" );
    const confirmResetYes = document.getElementById( "confirmResetYes" );
    const confirmResetNo = document.getElementById( "confirmResetNo" );

    let bigModeActive = false;

    if ( DEBUG_FAST_MODE ) fastBadge.classList.add( "show" );

    // ---------- helpers ----------
    function fmt ( sec )
    {
        sec = Math.max( 0, Math.floor( sec ) );
        const h = String( Math.floor( sec / 3600 ) ).padStart( 2, "0" );
        const m = String( Math.floor( ( sec % 3600 ) / 60 ) ).padStart( 2, "0" );
        const s = String( sec % 60 ).padStart( 2, "0" );
        return `${ h }:${ m }:${ s }`;
    }
    function fmtHours ( sec )
    {
        const h = sec / 3600;
        return ( h % 1 === 0 ) ? `${ h } ساعة` : `${ h.toFixed( 1 ) } ساعة`;
    }
    function showToast ( msg )
    {
        toast.textContent = msg;
        toast.classList.add( "show" );
        clearTimeout( showToast._t );
        showToast._t = setTimeout( () => toast.classList.remove( "show" ), 2800 );
    }
    function openOverlay ( el ) { el.classList.add( "open" ); }
    function closeOverlay ( el ) { el.classList.remove( "open" ); }

    // ---------- rendering ----------
    function renderDial ()
    {
        const th = threshold( state );
        const cyclePos = ( state.elapsed % th === 0 && state.elapsed > 0 ) ? th : state.elapsed % th;
        const pct = Math.min( 1, cyclePos / th );
        miniBarFill.style.width = ( pct * 100 ).toFixed( 2 ) + "%";
        timeDisplay.textContent = fmt( state.elapsed );
        goalText.textContent = fmtHours( th );
        goalTextStat.textContent = fmtHours( th );
        dialTree.className = "fa-solid tree-state " + ( pct > 0.85 ? "fa-tree" : pct > 0.4 ? "fa-leaf" : "fa-seedling" );
    }

    function renderStats ()
    {
        pointsStat.textContent = state.points;
        treesStat.textContent = state.smallTreesPlanted;
        bigStat.textContent = state.bigTreesPlanted;
        progressBigStat.textContent = `${ state.sinceLastBig }/10`;
        bigChargeCount.textContent = state.bigCharges;
        if ( state.bigCharges > 0 )
        {
            bigModeBtn.classList.add( "show" );
        } else
        {
            bigModeBtn.classList.remove( "show" );
            bigModeActive = false;
            bigModeBtn.classList.remove( "active" );
        }
        startBtn.innerHTML = state.isRunning ? "⏸ إيقاف مؤقت" : "▶ ابدأ";
    }

    function cellIcon ( v )
    {
        if ( v === "small" ) return `<i class="fa-solid fa-seedling planted"></i>`;
        if ( v === "big" ) return `<i class="fa-solid fa-tree planted big"></i>`;
        return "";
    }

    function renderGarden ()
    {
        gardenGrid.innerHTML = "";
        const frag = document.createDocumentFragment();
        for ( let i = 0; i < CELL_COUNT; i++ )
        {
            const div = document.createElement( "div" );
            div.className = "cell";
            div.dataset.index = i;
            const v = state.garden[ i ];
            if ( v ) div.innerHTML = cellIcon( v );
            else if ( state.points > 0 || bigModeActive ) div.classList.add( "plantable" );
            frag.appendChild( div );
        }
        gardenGrid.appendChild( frag );
    }

    function refreshPlantableHighlights ()
    {
        document.querySelectorAll( ".cell" ).forEach( cell =>
        {
            const i = Number( cell.dataset.index );
            if ( state.garden[ i ] ) return;
            cell.classList.toggle( "plantable", state.points > 0 || bigModeActive );
            cell.classList.toggle( "big-mode-target", bigModeActive );
        } );
    }

    function renderAll ()
    {
        renderDial();
        renderStats();
        lastProgressLine.textContent = `آخر حفظ: ${ fmt( state.elapsed ) } — الساعة ${ new Date( state.lastSavedAt ).toLocaleTimeString( 'ar-EG' ) }`;
    }

    // ---------- confetti ----------
    function burstConfetti ()
    {
        const colors = [ "#e8b64c", "#6fa356", "#f4d78a", "#3d6b3f", "#f2ead8" ];
        for ( let i = 0; i < 26; i++ )
        {
            const p = document.createElement( "div" );
            p.className = "confetti-piece";
            p.style.left = Math.random() * 100 + "vw";
            p.style.background = colors[ Math.floor( Math.random() * colors.length ) ];
            p.style.animationDuration = ( 2 + Math.random() * 1.5 ) + "s";
            p.style.opacity = String( 0.7 + Math.random() * 0.3 );
            document.body.appendChild( p );
            setTimeout( () => p.remove(), 3800 );
        }
    }

    ( function initFireflies ()
    {
        const holder = document.getElementById( "fireflies" );
        for ( let i = 0; i < 14; i++ )
        {
            const f = document.createElement( "div" );
            f.className = "firefly";
            f.style.left = Math.random() * 100 + "vw";
            f.style.top = Math.random() * 100 + "vh";
            f.style.animationDelay = ( Math.random() * 10 ) + "s";
            f.style.animationDuration = ( 9 + Math.random() * 8 ) + "s";
            holder.appendChild( f );
        }
    } )();

    // ---------- timer logic ----------
    // بدل ما نعتمد على عدد المرات اللي setInterval اشتغل فيها (اللي المتصفح
    // بيبطئها أو بيوقفها لما التبويب يبقى في الخلفية)، بنحسب الوقت الحقيقي
    // اللي عدى باستخدام Date.now(). فبمجرد ما التبويب يرجع يشتغل (أو حتى لو
    // الـ interval اشتغل مرة كل دقيقة بدل كل ثانية) هيتصحح الوقت فورًا لقد
    // الوقت الحقيقي اللي عدى، مش هيفضل واقف.
    let runStartEpoch = null;
    let elapsedAtRunStart = 0;

    function syncElapsedFromClock ()
    {
        if ( !state.isRunning || runStartEpoch === null ) return;
        const now = Date.now();
        const secondsPassed = Math.floor( ( now - runStartEpoch ) / 1000 );
        const factor = DEBUG_FAST_MODE ? FAST_SECONDS_PER_TICK : 1;
        const newElapsed = elapsedAtRunStart + secondsPassed * factor;
        if ( newElapsed > state.elapsed ) state.elapsed = newElapsed;
    }

    function tick ()
    {
        syncElapsedFromClock();

        // عندما يصل الوقت للهدف المجدول
        if ( state.elapsed >= state.nextMilestone )
        {
            state.points += 1;
            state.totalPointsEarned += 1;
            state.isRunning = false;

            // --- أضف هذا السطر هنا لتصفير الخصم ---
            state.reductionHours = 0;
            // ------------------------------------

            stopInterval();
            burstConfetti();
            milestoneText.textContent =
                `خدت نقطة جديدة 🌟 (معاك دلوقتي ${ state.points } نقطة). عايز تكمل العد من غير ما تاخد نقطة تانية دلوقتي، ولا تعمل ريستارت وتبدأ دورة جديدة من الصفر؟`;
            openOverlay( milestoneOverlay );
        }
        saveState();
        renderAll();
    }

    function startInterval ()
    {
        if ( intervalId ) return;
        runStartEpoch = Date.now();
        elapsedAtRunStart = state.elapsed;
        // بنستخدم تيك كل ثانية للعرض، لكن القيمة الحقيقية بتتحسب من الساعة
        // مش من عدد التيكات، فمفيش فرق لو المتصفح بطّأ الـ interval.
        intervalId = setInterval( tick, 1000 );
    }
    function stopInterval ()
    {
        syncElapsedFromClock();
        clearInterval( intervalId );
        intervalId = null;
        runStartEpoch = null;
    }

    function toggleRun ()
    {
        state.isRunning = !state.isRunning;
        if ( state.isRunning ) startInterval(); else stopInterval();
        saveState();
        renderAll();
    }

    function doReset ()
    {
        state.elapsed = 0;
        state.isRunning = false;
        state.nextMilestone = threshold( state );
        stopInterval();
        saveState();
        renderAll();
    }

    // ---------- garden logic ----------
    function plantSmall ( index )
    {
        state.points -= 1;
        state.garden[ index ] = "small";
        state.smallTreesPlanted += 1;
        state.sinceLastBig += 1;
        if ( state.sinceLastBig >= 10 )
        {
            state.sinceLastBig = 0;
            state.bigCharges += 1;
            showToast( "فتحت شجرة كبيرة جديدة! 🌲" );
        }
        saveState();
    }

    function plantBig ( index )
    {
        state.bigCharges -= 1;
        state.bigTreesPlanted += 1;
        state.garden[ index ] = "big";
        state.reductionHours += 1;
        state.points += 1; // نقطة إضافية مكافأة على الشجرة الكبيرة
        const th = threshold( state );
        state.nextMilestone = Math.max( state.elapsed + 1, state.nextMilestone - HOUR );
        showToast( `شجرة كبيرة اتزرعت 🌲 — كسبت نقطة إضافية وهدفك بقى ${ fmtHours( th ) }` );
        if ( state.bigCharges <= 0 ) bigModeActive = false;
        saveState();
    }

    gardenGrid.addEventListener( "click", ( e ) =>
    {
        const cell = e.target.closest( ".cell" );
        if ( !cell ) return;
        const index = Number( cell.dataset.index );
        if ( state.garden[ index ] ) { return; }

        if ( bigModeActive )
        {
            if ( state.bigCharges <= 0 ) { bigModeActive = false; renderGarden(); renderStats(); return; }
            plantBig( index );
            cell.innerHTML = cellIcon( "big" );

            // --- قم باستبدال renderStats() بهذا السطر ---
            renderAll();
            // ---------------------------------------------

            refreshPlantableHighlights();
            return;
        }

        if ( state.points <= 0 )
        {
            cell.classList.add( "shake" );
            setTimeout( () => cell.classList.remove( "shake" ), 400 );
            showToast( "معاك صفر نقط دلوقتي — استنى توصل لهدف الوقت عشان تاخد نقطة." );
            return;
        }

        plantSmall( index );
        cell.innerHTML = cellIcon( "small" );
        renderStats();
        refreshPlantableHighlights();
    } );

    bigModeBtn.addEventListener( "click", () =>
    {
        if ( state.bigCharges <= 0 ) return;
        bigModeActive = !bigModeActive;
        bigModeBtn.classList.toggle( "active", bigModeActive );
        refreshPlantableHighlights();
        showToast( bigModeActive ? "دلوقتي دوس على أي مربع فاضي عشان تزرع الشجرة الكبيرة." : "اتلغى وضع الشجرة الكبيرة." );
    } );

    // ---------- controls ----------
    startBtn.addEventListener( "click", toggleRun );
    resetBtn.addEventListener( "click", () => openOverlay( confirmResetOverlay ) );
    confirmResetYes.addEventListener( "click", () => { closeOverlay( confirmResetOverlay ); doReset(); } );
    confirmResetNo.addEventListener( "click", () => closeOverlay( confirmResetOverlay ) );

    milestoneContinueBtn.addEventListener( "click", () =>
    {
        state.nextMilestone += threshold( state );
        state.isRunning = true;
        startInterval();
        closeOverlay( milestoneOverlay );
        saveState();
        renderAll();
    } );
    milestoneRestartBtn.addEventListener( "click", () =>
    {
        closeOverlay( milestoneOverlay );
        doReset();
    } );

    resumeContinueBtn.addEventListener( "click", () =>
    {
        closeOverlay( resumeOverlay );
        renderAll();
    } );
    resumeRestartBtn.addEventListener( "click", () =>
    {
        closeOverlay( resumeOverlay );
        doReset();
    } );

    // ---------- real JSON file persistence ----------
    const hasFSAccess = "showSaveFilePicker" in window;
    if ( !hasFSAccess )
    {
        linkFileBtn.style.display = "none";
    }

    linkFileBtn.addEventListener( "click", async () =>
    {
        try
        {
            fileHandle = await window.showSaveFilePicker( {
                suggestedName: "garden-timer-save.json",
                types: [ { description: "JSON", accept: { "application/json": [ ".json" ] } } ]
            } );
            saveStatus.classList.remove( "disconnected" );
            saveStatus.innerHTML = `<i class="fa-solid fa-circle-check"></i> <span>متصل بملف: ${ fileHandle.name } — بيتحدث تلقائي</span>`;
            await persistToFile();
            showToast( "اتربط بملف JSON حقيقي، هيتحدث تلقائي كل ما تتغير حاجة." );
        } catch ( e )
        {
            // المستخدم لغى الاختيار
        }
    } );

    downloadBtn.addEventListener( "click", () =>
    {
        const blob = new Blob( [ JSON.stringify( state, null, 2 ) ], { type: "application/json" } );
        const url = URL.createObjectURL( blob );
        const a = document.createElement( "a" );
        a.href = url;
        a.download = "garden-timer-save.json";
        document.body.appendChild( a );
        a.click();
        a.remove();
        URL.revokeObjectURL( url );
        showToast( "اتنزلت نسخة JSON من بياناتك." );
    } );

    importBtn.addEventListener( "click", () => importInput.click() );
    importInput.addEventListener( "change", async ( e ) =>
    {
        const file = e.target.files[ 0 ];
        if ( !file ) return;
        try
        {
            const text = await file.text();
            const parsed = JSON.parse( text );
            if ( !parsed || !Array.isArray( parsed.garden ) ) throw new Error( "bad file" );
            stopInterval();
            state = parsed;
            if ( state.garden.length !== CELL_COUNT )
            {
                const g = new Array( CELL_COUNT ).fill( null );
                for ( let i = 0; i < Math.min( g.length, state.garden.length ); i++ ) g[ i ] = state.garden[ i ];
                state.garden = g;
            }
            state.isRunning = false;
            saveState();
            renderGarden();
            renderAll();
            refreshPlantableHighlights();
            showToast( "اتحمّلت بياناتك من الملف بنجاح." );
        } catch ( err )
        {
            showToast( "الملف ده مش متوافق، جرب ملف JSON اتصدر من نفس اللعبة." );
        }
        importInput.value = "";
    } );

    // ---------- persistence on close ----------
    window.addEventListener( "beforeunload", () => { state.isRunning = false; persistLocal(); } );
    document.addEventListener( "visibilitychange", () =>
    {
        if ( document.hidden )
        {
            saveState();
        } else if ( state.isRunning )
        {
            // التبويب رجع ظاهر: نصحح الوقت فورًا من الساعة الحقيقية
            // بدل ما ننتظر أول تيك تاني من الـ interval.
            tick();
        }
    } );

    // ---------- boot ----------
    function boot ()
    {
        renderGarden();
        const hadSave = !!loadStateFromLocalStorage();
        if ( hadSave && state.elapsed > 0 )
        {
            resumeText.textContent = `آخر مرة قفلت الساعة كانت واقفة على ${ fmt( state.elapsed ) }. عايز تكمل منها ولا تبدأ من الصفر؟`;
            openOverlay( resumeOverlay );
        }
        state.isRunning = false; // متبدأش تلقائي، المستخدم لازم يدوس ابدأ
        renderAll();
        refreshPlantableHighlights();
    }

    boot();
} )();