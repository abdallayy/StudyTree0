/* ============================================================
   garden3d.js — محرك حديقة الوقت ثلاثي الأبعاد (نسخة Premium)
   ------------------------------------------------------------
   مبني على Three.js + Web Audio API، بدون أي أدوات بناء (npm-free).
   مسؤول فقط عن العرض والتفاعل البصري/الصوتي؛ منطق اللعبة (النقط،
   الوقت، الحفظ) فاضل بالكامل في index.js. الـ API العام
   (Garden3D#init/applyState/plantAt/...) لسه نفسه بالظبط عشان
   index.js يشتغل من غير أي تعديل.

   الأنظمة الموجودة هنا:
     - SkySystem      : دورة نهار/ليل حقيقية (شمس، قمر، نجوم، سحاب)
     - WeatherSystem   : صافي / غيوم / مطر + رعد + أرض مبللة
     - TerrainSystem   : أرض بارتفاعات حقيقية + تكستشر إجرائي + صخور
     - TreeSystem      : أشجار متعددة الأنواع بحركة رياح حقيقية
     - GrassSystem     : عشب إجرائي بحركة رياح متجهة
     - BirdSystem       : طيور تطير في السماء نهارًا
     - ParticleSystems : fireflies / pollen / rain / dust
     - AudioSystem      : SoundEngine إجرائي كامل (Web Audio API)
     - PostFX           : Bloom اختياري (يعمل fallback لو المكتبة مش محمّلة)
     - CameraSystem      : intro سينمائي + focus + autoRotate
     - PerformanceSystem : كشف قدرة الجهاز وتقليل الحمل تلقائيًا
   ============================================================ */

( function ( global )
{
    "use strict";

    const COLS = 33;
    const ROWS = 11;
    const SPACING = 2.15;
    const PLOT_SIZE = SPACING * 0.8;
    const SMALL_TREE_H = 1.35;
    const BIG_TREE_H = 2.35;
    const DAY_CYCLE_SECONDS = 210; // مدة دورة يوم/ليلة كاملة (ثواني حقيقية)

    // ================================================================
    // ---------- helpers: noise, textures ----------
    // ================================================================
    function makeNoise2D ( seed )
    {
        const perm = new Uint8Array( 512 );
        let s = seed || 1337;
        function rnd () { s = ( s * 1103515245 + 12345 ) & 0x7fffffff; return s / 0x7fffffff; }
        const p = new Uint8Array( 256 );
        for ( let i = 0; i < 256; i++ ) p[ i ] = i;
        for ( let i = 255; i > 0; i-- )
        {
            const j = Math.floor( rnd() * ( i + 1 ) );
            const t = p[ i ]; p[ i ] = p[ j ]; p[ j ] = t;
        }
        for ( let i = 0; i < 512; i++ ) perm[ i ] = p[ i & 255 ];
        function fade ( t ) { return t * t * t * ( t * ( t * 6 - 15 ) + 10 ); }
        function lerp ( a, b, t ) { return a + t * ( b - a ); }
        function grad ( h, x, y )
        {
            const g = h & 3;
            const u = g < 2 ? x : y, v = g < 2 ? y : x;
            return ( ( g & 1 ) ? -u : u ) + ( ( g & 2 ) ? -2 * v : 2 * v );
        }
        return function ( x, y )
        {
            const X = Math.floor( x ) & 255, Y = Math.floor( y ) & 255;
            const xf = x - Math.floor( x ), yf = y - Math.floor( y );
            const u = fade( xf ), v = fade( yf );
            const aa = perm[ perm[ X ] + Y ], ab = perm[ perm[ X ] + Y + 1 ];
            const ba = perm[ perm[ X + 1 ] + Y ], bb = perm[ perm[ X + 1 ] + Y + 1 ];
            const x1 = lerp( grad( aa, xf, yf ), grad( ba, xf - 1, yf ), u );
            const x2 = lerp( grad( ab, xf, yf - 1 ), grad( bb, xf - 1, yf - 1 ), u );
            return lerp( x1, x2, v ) * 0.5 + 0.5;
        };
    }

    function makeFbm ( noise2D, octaves, lacunarity, gain )
    {
        return function ( x, y )
        {
            let amp = 0.5, freq = 1, sum = 0, norm = 0;
            for ( let i = 0; i < octaves; i++ )
            {
                sum += amp * noise2D( x * freq, y * freq );
                norm += amp;
                amp *= gain;
                freq *= lacunarity;
            }
            return sum / norm;
        };
    }

    function makeGlowTexture ( inner, outer )
    {
        const c = document.createElement( "canvas" );
        c.width = c.height = 64;
        const ctx = c.getContext( "2d" );
        const g = ctx.createRadialGradient( 32, 32, 0, 32, 32, 32 );
        g.addColorStop( 0, inner );
        g.addColorStop( 1, outer );
        ctx.fillStyle = g;
        ctx.fillRect( 0, 0, 64, 64 );
        return new THREE.CanvasTexture( c );
    }

    // تكستشر تربة/عشب إجرائي (بديل واقعي عن اللون المسطح، بدون تحميل أي صورة خارجية)
    function makeGroundTexture ( noise2D, sizePx )
    {
        const c = document.createElement( "canvas" );
        c.width = c.height = sizePx;
        const ctx = c.getContext( "2d" );
        const img = ctx.createImageData( sizePx, sizePx );
        const baseA = [ 0x5c, 0x74, 0x35 ]; // أخضر مزروع
        const baseB = [ 0x7a, 0x63, 0x3c ]; // بني تربة
        for ( let y = 0; y < sizePx; y++ )
        {
            for ( let x = 0; x < sizePx; x++ )
            {
                const n1 = noise2D( x * 0.045, y * 0.045 );
                const n2 = noise2D( x * 0.16 + 50, y * 0.16 + 50 );
                const mix = Math.min( 1, Math.max( 0, n1 * 0.75 + n2 * 0.25 ) );
                const speck = ( noise2D( x * 0.9, y * 0.9 ) - 0.5 ) * 18;
                const idx = ( y * sizePx + x ) * 4;
                for ( let k = 0; k < 3; k++ )
                {
                    const v = baseA[ k ] * mix + baseB[ k ] * ( 1 - mix ) + speck;
                    img.data[ idx + k ] = Math.min( 255, Math.max( 0, v ) );
                }
                img.data[ idx + 3 ] = 255;
            }
        }
        ctx.putImageData( img, 0, 0 );
        const tex = new THREE.CanvasTexture( c );
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    }

    // خريطة تدرّج بسيطة (Gradient Map) للـ MeshToonMaterial — بتحوّل الإضاءة
    // من تدرّج ناعم واقعي لخطوات واضحة (Cel-Shading) زي أسلوب الألعاب
    // الكرتونية (Zelda / Genshin-style)، وده اللي بيدي الحديقة "هوية" بصرية
    // مميزة بدل ما تحاول تقلد الواقع.
    function makeToonGradient ( steps )
    {
        const c = document.createElement( "canvas" );
        c.width = steps; c.height = 1;
        const ctx = c.getContext( "2d" );
        for ( let i = 0; i < steps; i++ )
        {
            const v = Math.round( ( i / ( steps - 1 ) ) * 255 );
            ctx.fillStyle = `rgb(${ v },${ v },${ v })`;
            ctx.fillRect( i, 0, 1, 1 );
        }
        const tex = new THREE.CanvasTexture( c );
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        return tex;
    }
    function makeStarTexture ()
    {
        return makeGlowTexture( "#ffffff", "rgba(255,255,255,0)" );
    }

    // خريطة نتوءات (Normal Map) إجرائية مولّدة من نفس دالة الـ noise، بديل
    // واقعي وخفيف الحجم عن تحميل صور خارجية — بتدي التربة والصخور إحساس
    // ملمس حقيقي تحت الإضاءة من غير أي تكلفة شبكة.
    function makeNormalMapFromNoise ( noise2D, sizePx, strength )
    {
        const c = document.createElement( "canvas" );
        c.width = c.height = sizePx;
        const ctx = c.getContext( "2d" );
        const img = ctx.createImageData( sizePx, sizePx );
        const h = new Float32Array( sizePx * sizePx );
        for ( let y = 0; y < sizePx; y++ )
            for ( let x = 0; x < sizePx; x++ )
                h[ y * sizePx + x ] = noise2D( x * 0.08, y * 0.08 ) * 0.7 + noise2D( x * 0.3 + 90, y * 0.3 + 90 ) * 0.3;
        const at = ( x, y ) => h[ ( ( y + sizePx ) % sizePx ) * sizePx + ( ( x + sizePx ) % sizePx ) ];
        for ( let y = 0; y < sizePx; y++ )
        {
            for ( let x = 0; x < sizePx; x++ )
            {
                const l = at( x - 1, y ), r = at( x + 1, y ), u = at( x, y - 1 ), d = at( x, y + 1 );
                let nx = -( r - l ) * strength, ny = -( d - u ) * strength, nz = 1.0;
                const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
                nx /= len; ny /= len; nz /= len;
                const idx = ( y * sizePx + x ) * 4;
                img.data[ idx ] = ( nx * 0.5 + 0.5 ) * 255;
                img.data[ idx + 1 ] = ( ny * 0.5 + 0.5 ) * 255;
                img.data[ idx + 2 ] = ( nz * 0.5 + 0.5 ) * 255;
                img.data[ idx + 3 ] = 255;
            }
        }
        ctx.putImageData( img, 0, 0 );
        const tex = new THREE.CanvasTexture( c );
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    }

    // خريطة خشونة (Roughness Map) إجرائية: بقع أكثر لمعان (تربة مبللة/صخور
    // ملساء) وبقع أكثر خشونة (تراب جاف) — بتدي MeshPhysicalMaterial رد فعل
    // واقعي لضوء الشمس بدل خشونة ثابتة مسطحة.
    function makeRoughnessMap ( noise2D, sizePx )
    {
        const c = document.createElement( "canvas" );
        c.width = c.height = sizePx;
        const ctx = c.getContext( "2d" );
        const img = ctx.createImageData( sizePx, sizePx );
        for ( let y = 0; y < sizePx; y++ )
        {
            for ( let x = 0; x < sizePx; x++ )
            {
                const n = noise2D( x * 0.05 + 20, y * 0.05 + 20 );
                const v = Math.round( 210 + ( n - 0.5 ) * 70 );
                const idx = ( y * sizePx + x ) * 4;
                img.data[ idx ] = img.data[ idx + 1 ] = img.data[ idx + 2 ] = Math.min( 255, Math.max( 0, v ) );
                img.data[ idx + 3 ] = 255;
            }
        }
        ctx.putImageData( img, 0, 0 );
        const tex = new THREE.CanvasTexture( c );
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    }

    function backOut ( x )
    {
        const c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow( x - 1, 3 ) + c1 * Math.pow( x - 1, 2 );
    }
    function smoothstep ( a, b, x )
    {
        const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
        return t * t * ( 3 - 2 * t );
    }
    function lerpColor ( out, cA, cB, t ) { out.copy( cA ).lerp( cB, t ); return out; }

    // ================================================================
    // ---------- SoundEngine: نظام صوت إجرائي كامل (Web Audio API) ----------
    // لا يعتمد على أي ملفات صوت خارجية — كل صوت متولّد رياضيًا في الوقت
    // الحقيقي، فهو خفيف الحجم ودايمًا شغال حتى بدون إنترنت.
    // ================================================================
    function SoundEngine ()
    {
        this.ctx = null;
        this.enabled = false;
        this.volume = 0.5;
        this.master = null;
        this._windSrc = null;
        this._windFilter = null;
        this._birdTimer = null;
        this._insectTimer = null;
        this._isNight = false;
        this._rainGain = null;
        this._rainSrc = null;
        this._rainTarget = 0;
        this._thunderTimer = null;
    }
    SoundEngine.prototype._ensureCtx = function ()
    {
        if ( this.ctx ) return;
        const AC = global.AudioContext || global.webkitAudioContext;
        if ( !AC ) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect( this.ctx.destination );
    };
    SoundEngine.prototype._noiseBuffer = function ()
    {
        const ctx = this.ctx;
        const buf = ctx.createBuffer( 1, ctx.sampleRate * 2, ctx.sampleRate );
        const d = buf.getChannelData( 0 );
        for ( let i = 0; i < d.length; i++ ) d[ i ] = Math.random() * 2 - 1;
        return buf;
    };
    SoundEngine.prototype.enable = function ()
    {
        this._ensureCtx();
        if ( !this.ctx ) return;
        if ( this.ctx.state === "suspended" ) this.ctx.resume();
        if ( this.enabled ) return;
        this.enabled = true;
        this._startWind();
        this._startRainBed();
        if ( this._isNight ) this._scheduleInsect(); else this._scheduleBird();
    };
    SoundEngine.prototype.disable = function ()
    {
        this.enabled = false;
        if ( this._windSrc ) { try { this._windSrc.stop(); } catch ( e ) { } this._windSrc = null; }
        if ( this._rainSrc ) { try { this._rainSrc.stop(); } catch ( e ) { } this._rainSrc = null; }
        if ( this._birdTimer ) { clearTimeout( this._birdTimer ); this._birdTimer = null; }
        if ( this._insectTimer ) { clearTimeout( this._insectTimer ); this._insectTimer = null; }
        if ( this._thunderTimer ) { clearTimeout( this._thunderTimer ); this._thunderTimer = null; }
    };
    SoundEngine.prototype.dispose = function ()
    {
        this.disable();
        if ( this.ctx ) { this.ctx.close().catch( () => { } ); }
        this.ctx = null; this.master = null; this._windFilter = null; this._windGain = null; this._rainGain = null;
    };
    SoundEngine.prototype.pause = function ()
    {
        if ( this.ctx && this.enabled && this.ctx.state === "running" ) this.ctx.suspend();
    };
    SoundEngine.prototype.resume = function ()
    {
        if ( this.ctx && this.enabled && this.ctx.state === "suspended" ) this.ctx.resume();
    };
    SoundEngine.prototype.setVolume = function ( v )
    {
        this.volume = v;
        if ( this.master ) this.master.gain.value = v;
    };
    SoundEngine.prototype._startWind = function ()
    {
        const ctx = this.ctx;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer();
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 420;
        filter.Q.value = 0.5;
        const g = ctx.createGain();
        g.gain.value = 0.06;
        src.connect( filter ); filter.connect( g ); g.connect( this.master );
        src.start();
        this._windSrc = src;
        this._windFilter = filter;
        this._windGain = g;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.07;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 140;
        lfo.connect( lfoGain );
        lfoGain.connect( filter.frequency );
        lfo.start();
    };
    // شدة الرياح تتغير حسب حالة الطقس (نسيم عادي أو عاصفة)
    SoundEngine.prototype.setWindStrength = function ( strength )
    {
        if ( !this._windGain ) return;
        const g = 0.045 + strength * 0.16;
        this._windGain.gain.setTargetAtTime( g, this.ctx.currentTime, 0.6 );
    };
    // ---------- مطر: ضجيج مرشّح high-pass بيتحكم فيه الشدة (0..1) ----------
    SoundEngine.prototype._startRainBed = function ()
    {
        const ctx = this.ctx;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer();
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = 1200;
        const g = ctx.createGain();
        g.gain.value = 0.0001;
        src.connect( filter ); filter.connect( g ); g.connect( this.master );
        src.start();
        this._rainSrc = src;
        this._rainGain = g;
    };
    SoundEngine.prototype.setRainIntensity = function ( intensity )
    {
        this._rainTarget = intensity;
        if ( !this._rainGain || !this.ctx ) return;
        const g = intensity * 0.22;
        this._rainGain.gain.setTargetAtTime( g, this.ctx.currentTime, 0.9 );
        if ( intensity > 0.5 ) this._scheduleThunder(); else if ( this._thunderTimer )
        { clearTimeout( this._thunderTimer ); this._thunderTimer = null; }
    };
    SoundEngine.prototype._scheduleThunder = function ()
    {
        if ( this._thunderTimer || !this.enabled ) return;
        const delay = 6000 + Math.random() * 12000;
        this._thunderTimer = setTimeout( () =>
        {
            this._thunderTimer = null;
            if ( this._rainTarget > 0.5 ) { this.thunder(); this._scheduleThunder(); }
        }, delay );
    };
    SoundEngine.prototype.thunder = function ()
    {
        this._ensureCtx();
        if ( !this.ctx || !this.enabled ) return;
        const ctx = this.ctx; const t0 = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer();
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime( 480, t0 );
        filter.frequency.exponentialRampToValueAtTime( 90, t0 + 1.4 );
        const g = ctx.createGain();
        g.gain.setValueAtTime( 0.0001, t0 );
        g.gain.linearRampToValueAtTime( 0.5, t0 + 0.05 );
        g.gain.exponentialRampToValueAtTime( 0.0001, t0 + 1.6 );
        src.connect( filter ); filter.connect( g ); g.connect( this.master );
        src.start( t0 ); src.stop( t0 + 1.7 );
        if ( this._onThunder ) this._onThunder();
    };
    SoundEngine.prototype.onThunder = function ( cb ) { this._onThunder = cb; };
    // ---------- طيور نهارًا / حشرات ليلًا (جدولة تتبادل حسب الوقت) ----------
    SoundEngine.prototype.setDayNight = function ( isNight )
    {
        if ( this._isNight === isNight ) return;
        this._isNight = isNight;
        if ( !this.enabled ) return;
        if ( isNight )
        {
            if ( this._birdTimer ) { clearTimeout( this._birdTimer ); this._birdTimer = null; }
            this._scheduleInsect();
        } else
        {
            if ( this._insectTimer ) { clearTimeout( this._insectTimer ); this._insectTimer = null; }
            this._scheduleBird();
        }
    };
    SoundEngine.prototype._scheduleBird = function ()
    {
        if ( !this.enabled || this._isNight ) return;
        const ctx = this.ctx;
        const delay = 2500 + Math.random() * 6000;
        this._birdTimer = setTimeout( () =>
        {
            if ( !this.enabled || this._isNight ) return;
            const t0 = ctx.currentTime;
            const osc = ctx.createOscillator();
            osc.type = "sine";
            const g = ctx.createGain();
            const base = 1500 + Math.random() * 900;
            osc.frequency.setValueAtTime( base, t0 );
            osc.frequency.exponentialRampToValueAtTime( base * 1.4, t0 + 0.08 );
            osc.frequency.exponentialRampToValueAtTime( base * 0.9, t0 + 0.16 );
            g.gain.setValueAtTime( 0.0001, t0 );
            g.gain.linearRampToValueAtTime( 0.035, t0 + 0.02 );
            g.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.22 );
            osc.connect( g ); g.connect( this.master );
            osc.start( t0 ); osc.stop( t0 + 0.25 );
            this._scheduleBird();
        }, delay );
    };
    SoundEngine.prototype._scheduleInsect = function ()
    {
        if ( !this.enabled || !this._isNight ) return;
        const ctx = this.ctx;
        const delay = 120 + Math.random() * 260;
        this._insectTimer = setTimeout( () =>
        {
            if ( !this.enabled || !this._isNight ) return;
            const t0 = ctx.currentTime;
            const osc = ctx.createOscillator();
            osc.type = "square";
            const base = 3200 + Math.random() * 900;
            osc.frequency.value = base;
            const g = ctx.createGain();
            g.gain.setValueAtTime( 0.0001, t0 );
            g.gain.linearRampToValueAtTime( 0.012, t0 + 0.01 );
            g.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.09 );
            osc.connect( g ); g.connect( this.master );
            osc.start( t0 ); osc.stop( t0 + 0.1 );
            this._scheduleInsect();
        }, delay );
    };
    SoundEngine.prototype.plant = function ( big )
    {
        this._ensureCtx();
        if ( !this.ctx ) return;
        const ctx = this.ctx; const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        const g = ctx.createGain();
        const base = big ? 180 : 320;
        osc.frequency.setValueAtTime( base, t0 );
        osc.frequency.exponentialRampToValueAtTime( base * 2.2, t0 + 0.18 );
        g.gain.setValueAtTime( 0.0001, t0 );
        g.gain.linearRampToValueAtTime( big ? 0.18 : 0.12, t0 + 0.015 );
        g.gain.exponentialRampToValueAtTime( 0.0001, t0 + ( big ? 0.6 : 0.35 ) );
        osc.connect( g ); g.connect( this.master );
        osc.start( t0 ); osc.stop( t0 + ( big ? 0.65 : 0.4 ) );
    };
    SoundEngine.prototype.hover = function ()
    {
        this._ensureCtx();
        if ( !this.ctx || !this.enabled ) return;
        const ctx = this.ctx; const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 900;
        const g = ctx.createGain();
        g.gain.setValueAtTime( 0.0001, t0 );
        g.gain.linearRampToValueAtTime( 0.02, t0 + 0.01 );
        g.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.09 );
        osc.connect( g ); g.connect( this.master );
        osc.start( t0 ); osc.stop( t0 + 0.1 );
    };
    SoundEngine.prototype.reject = function ()
    {
        this._ensureCtx();
        if ( !this.ctx || !this.enabled ) return;
        const ctx = this.ctx; const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.setValueAtTime( 160, t0 );
        osc.frequency.linearRampToValueAtTime( 90, t0 + 0.15 );
        const g = ctx.createGain();
        g.gain.setValueAtTime( 0.04, t0 );
        g.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.18 );
        osc.connect( g ); g.connect( this.master );
        osc.start( t0 ); osc.stop( t0 + 0.2 );
    };
    SoundEngine.prototype.select = function ()
    {
        this._ensureCtx();
        if ( !this.ctx ) return;
        const ctx = this.ctx; const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime( 620, t0 );
        osc.frequency.exponentialRampToValueAtTime( 980, t0 + 0.12 );
        const g = ctx.createGain();
        g.gain.setValueAtTime( 0.0001, t0 );
        g.gain.linearRampToValueAtTime( 0.05, t0 + 0.015 );
        g.gain.exponentialRampToValueAtTime( 0.0001, t0 + 0.2 );
        osc.connect( g ); g.connect( this.master );
        osc.start( t0 ); osc.stop( t0 + 0.22 );
    };

    // ================================================================
    // ---------- Garden3D: الكائن الرئيسي ----------
    // ================================================================
    function Garden3D ( container, cellCount )
    {
        this.container = container;
        this.cellCount = cellCount;
        this.sound = new SoundEngine();
        this._ready = false;
        this._raf = null;
        this._clock = null;
        this._plantable = new Uint8Array( cellCount );
        this._planted = new Array( cellCount ).fill( null );
        this._hoverIndex = -1;
        this._onPlant = null;      // (index) => void   — المستخدم دوس على مربع فاضي صالح
        this._onTreeClick = null;  // (index, type) => void
        this._onWeatherChange = null;
        this._onTimeOfDay = null;
        this._focused = false;
        this._season = "spring";
        this._weather = { type: "clear", intensity: 0, target: 0, windStrength: 0.15 };
        this._nextWeatherChangeAt = 24 + Math.random() * 40; // بالثواني
    }

    Garden3D.prototype.isSupported = function ()
    {
        try
        {
            const c = document.createElement( "canvas" );
            return !!( global.THREE && ( c.getContext( "webgl" ) || c.getContext( "experimental-webgl" ) ) );
        } catch ( e ) { return false; }
    };

    // ---------- كشف قدرة الجهاز عشان نضبط الجودة تلقائيًا ----------
    Garden3D.prototype._detectPerfTier = function ()
    {
        const cores = global.navigator.hardwareConcurrency || 4;
        const mem = global.navigator.deviceMemory || 4;
        const dpr = global.devicePixelRatio || 1;
        const smallScreen = Math.min( global.innerWidth || 1200, global.innerHeight || 800 ) < 700;
        let tier = "high";
        if ( cores <= 2 || mem <= 2 ) tier = "low";
        else if ( cores <= 4 || mem <= 4 || smallScreen ) tier = "medium";
        if ( dpr > 2.5 && tier === "high" ) tier = "medium";
        return tier;
    };

    Garden3D.prototype.init = function ()
    {
        const self = this;
        const width = this.container.clientWidth || 800;
        const height = this.container.clientHeight || 480;

        const tier = this._detectPerfTier();
        this._tier = tier;
        const settings = {
            low: { grass: 900, fireflies: 18, pollen: 30, birds: 4, stars: 900, shadow: 1024, bloom: false, rain: 500, flowers: 90 },
            medium: { grass: 2200, fireflies: 32, pollen: 60, birds: 7, stars: 1500, shadow: 1536, bloom: false, rain: 900, flowers: 180 },
            high: { grass: 4200, fireflies: 46, pollen: 90, birds: 10, stars: 2200, shadow: 2048, bloom: true, rain: 1500, flowers: 280 }
        }[ tier ];
        this._settings = settings;

        const noise = makeNoise2D( 91177 );
        const fbm = makeFbm( noise, 3, 2.1, 0.55 );
        this._terrainHeight = function ( x, z )
        {
            return fbm( x * 0.045, z * 0.045 ) * 1.3 + noise( x * 0.12, z * 0.12 ) * 0.22 - 0.65;
        };

        const scene = new THREE.Scene();
        this.scene = scene;
        scene.fog = new THREE.FogExp2( 0x9bb7ad, 0.018 );
        this._fogNight = new THREE.Color( 0x0c1024 );
        this._fogDay = new THREE.Color( 0xb98a6a );

        const camera = new THREE.PerspectiveCamera( 42, width / height, 0.1, 400 );
        this.camera = camera;
        const fieldW = COLS * SPACING, fieldD = ROWS * SPACING;
        const worldW = fieldW + 48, worldD = fieldD + 72;
        this._fieldW = fieldW; this._fieldD = fieldD;
        this._worldW = worldW; this._worldD = worldD;
        this._defaultCamPos = new THREE.Vector3( fieldW * 0.24, fieldW * 0.19, fieldD * 0.96 );
        this._defaultTarget = new THREE.Vector3( 0, -0.15, -fieldD * 0.24 );
        camera.position.copy( this._defaultCamPos );

        const renderer = new THREE.WebGLRenderer( { antialias: true, alpha: false, powerPreference: "high-performance" } );
        // نطاق الدقة الديناميكية (Dynamic Resolution): بنبدأ من أعلى دقة
        // مسموحة للجهاز، وبعدين لو الإطارات وقعت تحت 40 FPS في الأنيميشن
        // لوب بننزّل الـ pixelRatio تدريجيًا، ولو الأداء رجع كويس بنرفعها تاني —
        // كل ده من غير ما نوقف الرندر أو نغيّر جودة أي حاجة تانية.
        this._pixelRatioMax = Math.min( global.devicePixelRatio || 1, tier === "high" ? 2 : 1.5 );
        this._pixelRatioMin = Math.min( this._pixelRatioMax, 0.75 );
        this._pixelRatioCurrent = this._pixelRatioMax;
        renderer.setPixelRatio( this._pixelRatioCurrent );
        renderer.setSize( width, height );
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        if ( "outputColorSpace" in renderer ) renderer.outputColorSpace = THREE.SRGBColorSpace;
        else if ( "outputEncoding" in renderer ) renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.86;
        this.renderer = renderer;
        this.container.appendChild( renderer.domElement );

        // ---------- controls ----------
        let controls = null;
        if ( THREE.OrbitControls )
        {
            controls = new THREE.OrbitControls( camera, renderer.domElement );
            controls.target.copy( this._defaultTarget );
            controls.enableDamping = true;
            controls.dampingFactor = 0.08;
            controls.minDistance = fieldD * 0.35;
            controls.maxDistance = fieldD * 2.4;
            controls.maxPolarAngle = Math.PI * 0.49;
            controls.minPolarAngle = Math.PI * 0.08;
            controls.enablePan = true;
            controls.panSpeed = 0.5;
            controls.autoRotate = true;
            controls.autoRotateSpeed = 0.28;
            controls.update();
        }
        this.controls = controls;

        // ---------- SkySystem: قبة سماء متدرجة + شمس/قمر/نجوم ----------
        this._buildSky( fieldW, fieldD, settings );

        // ---------- lighting ----------
        // ملحوظة: الحديقة بقت شغالة في وضع ليلي دايمًا (نجوم ظاهرة طول الوقت)،
        // فرفعنا شدة الإضاءة الليلية بشكل واضح عشان الأشجار والعشب تبان بوضوح
        // من غير ما نخسر جو الليل والنجوم.
        const hemi = new THREE.HemisphereLight( 0xd9edff, 0x34452f, 0.72 );
        scene.add( hemi );
        this._hemi = hemi;
        const sun = new THREE.DirectionalLight( 0xffd39a, 2.2 );
        sun.castShadow = true;
        sun.shadow.mapSize.set( settings.shadow, settings.shadow );
        sun.shadow.camera.near = 1;
        sun.shadow.camera.far = fieldW * 1.6;
        sun.shadow.camera.left = -fieldW * 0.65;
        sun.shadow.camera.right = fieldW * 0.65;
        sun.shadow.camera.top = fieldD * 0.9;
        sun.shadow.camera.bottom = -fieldD * 0.9;
        sun.shadow.bias = -0.0015;
        scene.add( sun );
        scene.add( sun.target );
        this._sun = sun;
        const moonLight = new THREE.DirectionalLight( 0xaecbff, 0.35 );
        moonLight.castShadow = false;
        moonLight.shadow.mapSize.set( settings.shadow, settings.shadow );
        moonLight.shadow.camera.near = 1;
        moonLight.shadow.camera.far = fieldW * 1.6;
        moonLight.shadow.camera.left = -fieldW * 0.65;
        moonLight.shadow.camera.right = fieldW * 0.65;
        moonLight.shadow.camera.top = fieldD * 0.9;
        moonLight.shadow.camera.bottom = -fieldD * 0.9;
        moonLight.shadow.bias = -0.0015;
        scene.add( moonLight );
        scene.add( moonLight.target );
        this._moonLight = moonLight;
        const fill = new THREE.AmbientLight( 0x71806f, 0.28 );
        scene.add( fill );
        this._fillLight = fill;
        // إضاءة دافية لطيفة قريبة من سطح الحديقة عشان تبرز الأشجار والعشب
        // في الضلمة زي فوانيس حديقة، من غير ما تبوظ جو الليل.
        const gardenGlow = new THREE.PointLight( 0xffdca8, 0.18, fieldW * 0.9, 2 );
        gardenGlow.position.set( 0, Math.max( fieldW, fieldD ) * 0.22, 0 );
        scene.add( gardenGlow );
        this._gardenGlow = gardenGlow;

        // ---------- TerrainSystem ----------
        this._buildTerrain( worldW, worldD, noise );

        // ---------- plot positions ----------
        this._plotPos = new Array( this.cellCount );
        for ( let i = 0; i < this.cellCount; i++ )
        {
            const col = i % COLS, row = Math.floor( i / COLS );
            const x = ( col - ( COLS - 1 ) / 2 ) * SPACING;
            const z = ( row - ( ROWS - 1 ) / 2 ) * SPACING;
            const y = this._terrainHeight( x, z );
            this._plotPos[ i ] = new THREE.Vector3( x, y, z );
        }

        // ---------- soil plots (instanced) ----------
        this._buildSoil();

        // ---------- TreeSystem: نوعين من الأشجار لتنوع بصري ----------
        this._smallTreeMesh = this._buildTreeInstances( SMALL_TREE_H, 0.85, 0x63b25c, false );
        this._bigTreeMesh = this._buildTreeInstances( BIG_TREE_H, 1.55, 0x4fae5b, true );
        scene.add( this._smallTreeMesh.mesh );
        scene.add( this._bigTreeMesh.mesh );

        // ---------- GrassSystem ----------
        this._buildGrass( fieldW, fieldD, settings.grass );

        // ---------- Rocks ----------
        this._buildRocks( fieldW, fieldD );

        // ---------- farm structures ----------
        this._buildFarmProps( fieldW, fieldD );
        this._buildWorldRegions( fieldW, fieldD, worldW, worldD );

        // ---------- clouds ----------
        this._buildClouds( fieldW );
        this._buildRainbow( fieldW, fieldD );

        // ---------- BirdSystem ----------
        this._buildBirds( fieldW, fieldD, settings.birds );

        // ---------- particles ----------
        this._buildFireflies( fieldW, fieldD, settings.fireflies );
        this._buildPollen( fieldW, fieldD, settings.pollen );
        this._buildRain( fieldW, fieldD, settings.rain );

        // ---------- PostFX (bloom اختياري) ----------
        this._buildPostFX( width, height, settings );

        // ---------- raycasting / interaction ----------
        this._raycaster = new THREE.Raycaster();
        this._mouse = new THREE.Vector2();
        this._setupInteraction();

        // ---------- weather -> sound wiring ----------
        this.sound.onThunder( () =>
        {
            this._thunderFlashT = 0.001; // يبدأ وميض سريع في الفريم الجاي
        } );

        // ---------- resize ----------
        this._resizeObs = new ResizeObserver( () => self._onResize() );
        this._resizeObs.observe( this.container );

        // ---------- cinematic intro ----------
        this._clock = new THREE.Clock();
        // الحديقة بقت ليلية بشكل دائم بطلب المستخدم (نجوم ظاهرة طول الوقت)،
        // فبنثبّت الوقت على نقطة "ليل صافي وقمر عالي" بدل ما ندوّر دورة يوم/ليل.
        this._dayT = 0.23;
        this._forceNight = false;
        this._introT = 0;
        this._introFrom = new THREE.Vector3( fieldW * 0.62, fieldW * 0.62, fieldD * 1.8 );
        camera.position.copy( this._introFrom );

        // ---------- FlowerSystem: ورد ملوّن منتشر بين العشب ----------
        this._buildFlowers( fieldW, fieldD, settings.flowers );

        this._ready = true;
        this._animate();
        return true;
    };

    // ================================================================
    // ---------- SkySystem ----------
    // ================================================================
    Garden3D.prototype._buildSky = function ( fieldW, fieldD, settings )
    {
        const radius = Math.max( fieldW, fieldD ) * 2.2;
        const skyGeo = new THREE.SphereGeometry( radius, 24, 16 );
        // ---------------------------------------------------------------
        // هوية بصرية جديدة للسما: مش تدرّج واقعي بسيط، دلوقتي فيه سديم
        // (Nebula) متحرك بألوان جوهرية (نيلي/فيروزي/بنفسجي) + شرائط شفق
        // قطبي (Aurora) بتتموّج فوق الأفق بالليل — كل ده متولّد بالكامل
        // جوه الـ Fragment Shader بـ value-noise رخيص، فمفيش أي تكلفة على
        // الـ CPU ولا أي تكستشر خارجية، وشكل السما بقى مميز وله طابع
        // خاص بدل ما يكون تدرّج سماء عادي.
        const skyMat = new THREE.ShaderMaterial( {
            uniforms: {
                uTop: { value: new THREE.Color( "#0c0a2e" ) },
                uMid: { value: new THREE.Color( "#4a2f6b" ) },
                uBottom: { value: new THREE.Color( "#e78a5a" ) },
                uSunDir: { value: new THREE.Vector3( 0, 1, 0 ) },
                uSeason: { value: 0 },
                uTime: { value: 0 },
                uNightFactor: { value: 0.5 }
            },
            vertexShader: `
                varying vec3 vPos;
                void main() {
                    vPos = normalize( position );
                    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
                }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uTop, uMid, uBottom, uSunDir;
                uniform float uSeason, uTime, uNightFactor;

                // value-noise رخيص جدًا (hash-based) — كافي لسديم وشفق ناعمين
                // من غير ما يكلف الـ GPU حاجة تُذكر.
                float hash21( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
                float noise2( vec2 p ) {
                    vec2 i = floor( p ), f = fract( p );
                    float a = hash21( i ), b = hash21( i + vec2( 1.0, 0.0 ) );
                    float c = hash21( i + vec2( 0.0, 1.0 ) ), d = hash21( i + vec2( 1.0, 1.0 ) );
                    vec2 u = f * f * ( 3.0 - 2.0 * f );
                    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
                }
                float fbm2( vec2 p ) {
                    float s = 0.0, amp = 0.5;
                    for ( int i = 0; i < 4; i++ ) { s += amp * noise2( p ); p *= 2.02; amp *= 0.55; }
                    return s;
                }

                void main() {
                    float h = clamp( vPos.y * 0.5 + 0.5, 0.0, 1.0 );
                    vec3 col = mix( uBottom, uMid, smoothstep( 0.0, 0.55, h ) );
                    col = mix( col, uTop, smoothstep( 0.45, 1.0, h ) );
                    float horizon = pow( 1.0 - abs( vPos.y ), 2.0 );
                    float sunGlow = pow( max( dot( vPos, normalize( uSunDir ) ), 0.0 ), 18.0 );
                    col += vec3( 1.0, 0.38, 0.12 ) * sunGlow * ( 0.18 + horizon * 0.24 );
                    col = mix( col, col * vec3( 0.82, 0.9, 1.08 ), smoothstep( 2.0, 3.0, uSeason ) * 0.3 );

                    // --- سديم ملوّن يملأ القبة العلوية بهوية جوهرية مميزة ---
                    vec2 nebUV = vec2( atan( vPos.z, vPos.x ) * 0.6, vPos.y * 1.3 ) + vec2( uTime * 0.004, 0.0 );
                    float neb = fbm2( nebUV * 2.2 );
                    vec3 nebColorA = vec3( 0.35, 0.16, 0.55 );  // بنفسجي
                    vec3 nebColorB = vec3( 0.08, 0.55, 0.62 );  // فيروزي
                    vec3 nebColor = mix( nebColorA, nebColorB, smoothstep( 0.3, 0.75, neb ) );
                    float nebMask = smoothstep( 0.15, 0.85, h ) * smoothstep( 0.35, 0.7, neb ) * uNightFactor;
                    col += nebColor * nebMask * 0.55;

                    // --- شرائط شفق قطبي متموّجة فوق الأفق (بالليل بس) ---
                    float auroraBand = sin( vPos.x * 2.4 + uTime * 0.25 + fbm2( vec2( vPos.x * 1.6, uTime * 0.06 ) ) * 3.0 );
                    float auroraMask = smoothstep( 0.05, 0.45, h ) * smoothstep( 0.55, 0.1, h ) * uNightFactor;
                    float auroraGlow = pow( max( auroraBand, 0.0 ), 3.0 ) * auroraMask;
                    vec3 auroraColor = mix( vec3( 0.25, 1.0, 0.65 ), vec3( 0.55, 0.35, 1.0 ), smoothstep( -1.0, 1.0, sin( vPos.x * 1.1 + uTime * 0.1 ) ) );
                    col += auroraColor * auroraGlow * 0.5;

                    gl_FragColor = vec4( col, 1.0 );
                }`,
            side: THREE.BackSide,
            depthWrite: false
        } );
        const sky = new THREE.Mesh( skyGeo, skyMat );
        this.scene.add( sky );
        this._sky = sky;

        // نجوم على القبة (تظهر بالليل فقط بتغيير الـ opacity) — دلوقتي كل
        // نجمة ليها "phase" عشوائي جوه الـ Vertex Shader فبتلمع وتخبو
        // (Twinkle) بشكل مستقل عن بعضها بدل ما تكون كتلة نقط ثابتة، وده
        // اللي بيدي تفصيلة "سما حية" مميزة للعبة.
        const starCount = settings.stars;
        const starGeo = new THREE.BufferGeometry();
        const starPos = new Float32Array( starCount * 3 );
        const starPhase = new Float32Array( starCount );
        const starSize = new Float32Array( starCount );
        for ( let i = 0; i < starCount; i++ )
        {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos( Math.random() * 0.85 ); // نصف الكرة العلوي أساسًا
            const r = radius * 0.98;
            starPos[ i * 3 ] = r * Math.sin( phi ) * Math.cos( theta );
            starPos[ i * 3 + 1 ] = r * Math.cos( phi );
            starPos[ i * 3 + 2 ] = r * Math.sin( phi ) * Math.sin( theta );
            starPhase[ i ] = Math.random() * Math.PI * 2;
            starSize[ i ] = 1.1 + Math.random() * 1.8;
        }
        starGeo.setAttribute( "position", new THREE.BufferAttribute( starPos, 3 ) );
        starGeo.setAttribute( "aPhase", new THREE.BufferAttribute( starPhase, 1 ) );
        starGeo.setAttribute( "aSize", new THREE.BufferAttribute( starSize, 1 ) );
        const starMat = new THREE.ShaderMaterial( {
            uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uMap: { value: makeStarTexture() } },
            vertexShader: `
                attribute float aPhase; attribute float aSize;
                uniform float uTime;
                varying float vTwinkle;
                void main() {
                    vTwinkle = 0.55 + 0.45 * sin( uTime * 1.6 + aPhase );
                    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
                    gl_Position = projectionMatrix * mv;
                    gl_PointSize = aSize * vTwinkle;
                }`,
            fragmentShader: `
                uniform sampler2D uMap; uniform float uOpacity;
                varying float vTwinkle;
                void main() {
                    vec4 tex = texture2D( uMap, gl_PointCoord );
                    gl_FragColor = vec4( tex.rgb, tex.a * uOpacity * vTwinkle );
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        } );
        const stars = new THREE.Points( starGeo, starMat );
        this.scene.add( stars );
        this._stars = stars;
        const starLayers = [];
        [ { count: Math.round( starCount * 0.22 ), size: 2.8, color: 0xfff4d6 }, { count: Math.round( starCount * 0.16 ), size: 1.1, color: 0xbfdcff } ].forEach( layer =>
        {
            const geo = new THREE.BufferGeometry();
            const pos = new Float32Array( layer.count * 3 );
            for ( let i = 0; i < layer.count; i++ )
            {
                const theta = Math.random() * Math.PI * 2, phi = Math.acos( Math.random() * 0.85 ), r = radius * 0.965;
                pos[ i * 3 ] = r * Math.sin( phi ) * Math.cos( theta ); pos[ i * 3 + 1 ] = r * Math.cos( phi ); pos[ i * 3 + 2 ] = r * Math.sin( phi ) * Math.sin( theta );
            }
            geo.setAttribute( "position", new THREE.BufferAttribute( pos, 3 ) );
            const points = new THREE.Points( geo, new THREE.PointsMaterial( { size: layer.size, color: layer.color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false } ) );
            this.scene.add( points ); starLayers.push( points );
        } );
        this._starLayers = starLayers;

        // قرص الشمس والقمر (Sprites بسيطة تدور حوالين الحقل)
        const sunTex = makeGlowTexture( "#fff6d8", "rgba(255,246,216,0)" );
        const sunSprite = new THREE.Sprite( new THREE.SpriteMaterial( {
            map: sunTex, color: 0xffe9b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        } ) );
        sunSprite.scale.set( 14, 14, 1 );
        this.scene.add( sunSprite );
        this._sunSprite = sunSprite;

        const moonTex = makeGlowTexture( "#e8f0ff", "rgba(232,240,255,0)" );
        const moonSprite = new THREE.Sprite( new THREE.SpriteMaterial( {
            map: moonTex, color: 0xcfe0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        } ) );
        moonSprite.scale.set( 9, 9, 1 );
        this.scene.add( moonSprite );
        this._moonSprite = moonSprite;
        const moon = new THREE.Mesh( new THREE.SphereGeometry( 2.4, 20, 14 ), new THREE.MeshStandardMaterial( { color: 0xb8c5ce, roughness: 0.95, emissive: 0x28364a, emissiveIntensity: 0.25 } ) );
        this.scene.add( moon ); this._moon = moon;

        this._skyRadius = radius;
        this._buildShootingStars( radius );
    };

    Garden3D.prototype._buildShootingStars = function ( radius )
    {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute( "position", new THREE.BufferAttribute( new Float32Array( 6 ), 3 ) );
        const mat = new THREE.LineBasicMaterial( { color: 0xffe8b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending } );
        const line = new THREE.Line( geo, mat ); this.scene.add( line );
        this._shootingStar = { line, radius, timer: 5 + Math.random() * 12, progress: -1, start: new THREE.Vector3(), end: new THREE.Vector3() };
    };

    // دورة اليوم/الليل — بتتحكم في الشمس/القمر/الإضاءة/الفوج/السحاب/النجوم
    Garden3D.prototype._updateDayNight = function ( dt )
    {
        // في الوضع الليلي الدائم بنثبّت "t" فمفيش دوران يوم/ليل، لكن باقي
        // الأنظمة (شمس/قمر/نجوم/إضاءة) بتفضل شغالة عادي على القيمة الثابتة دي.
        this._dayT = this._forceNight ? this._dayT : ( this._dayT + dt / DAY_CYCLE_SECONDS ) % 1;
        const t = this._dayT;
        const angle = t * Math.PI * 2;
        const sunY = Math.sin( angle );
        const sunX = Math.cos( angle );
        const R = Math.max( this._fieldW, this._fieldD ) * 1.35;

        const sunPos = new THREE.Vector3( sunX * R, sunY * R * 0.85 + R * 0.15, this._fieldD * 0.2 );
        this._sun.position.copy( sunPos );
        this._sun.target.position.set( 0, 0, 0 );
        this._sunSprite.position.copy( sunPos ).multiplyScalar( 1.0 );

        const moonAngle = angle + Math.PI;
        const moonPos = new THREE.Vector3( Math.cos( moonAngle ) * R, Math.sin( moonAngle ) * R * 0.85 + R * 0.15, this._fieldD * 0.2 );
        this._moonLight.position.copy( moonPos );
        this._moonLight.target.position.set( 0, 0, 0 );
        this._moonSprite.position.copy( moonPos );
        if ( this._moon ) this._moon.position.copy( moonPos );

        const dayFactor = smoothstep( -0.15, 0.25, sunY );      // 0 بالليل، 1 بالنهار
        const nightFactor = 1 - dayFactor;
        const isNight = sunY < -0.05;
        if ( isNight !== this._isNightCached )
        {
            this._isNightCached = isNight;
            this.sound.setDayNight( isNight );
            if ( this._onTimeOfDay ) this._onTimeOfDay( isNight ? "night" : "day" );
        }

        // ألوان السما تتحرك بين ليل عميق -> شروق -> نهار -> غروب -> ليل
        const nightTop = new THREE.Color( "#050614" ), nightMid = new THREE.Color( "#0c1233" ), nightBot = new THREE.Color( "#1b2440" );
        const dawnTop = new THREE.Color( "#2b2450" ), dawnMid = new THREE.Color( "#a06a7a" ), dawnBot = new THREE.Color( "#f0a35f" );
        const dayTop = new THREE.Color( "#327fc0" ), dayMid = new THREE.Color( "#8bc6d4" ), dayBot = new THREE.Color( "#d8e5d2" );
        const duskTop = new THREE.Color( "#221c46" ), duskMid = new THREE.Color( "#8a5570" ), duskBot = new THREE.Color( "#e2793f" );

        const cTop = new THREE.Color(), cMid = new THREE.Color(), cBot = new THREE.Color();
        // نلف على 4 مراحل: ليل(0-.2) شروق(.2-.35) نهار(.35-.65) غروب(.65-.8) رجوع لليل(.8-1)
        function stage ( a, b, x ) { return smoothstep( a, b, x ); }
        if ( t < 0.2 )
        {
            const k = stage( 0, 0.2, t );
            cTop.copy( nightTop ).lerp( dawnTop, k ); cMid.copy( nightMid ).lerp( dawnMid, k ); cBot.copy( nightBot ).lerp( dawnBot, k );
        } else if ( t < 0.35 )
        {
            const k = stage( 0.2, 0.35, t );
            cTop.copy( dawnTop ).lerp( dayTop, k ); cMid.copy( dawnMid ).lerp( dayMid, k ); cBot.copy( dawnBot ).lerp( dayBot, k );
        } else if ( t < 0.65 )
        {
            cTop.copy( dayTop ); cMid.copy( dayMid ); cBot.copy( dayBot );
        } else if ( t < 0.8 )
        {
            const k = stage( 0.65, 0.8, t );
            cTop.copy( dayTop ).lerp( duskTop, k ); cMid.copy( dayMid ).lerp( duskMid, k ); cBot.copy( dayBot ).lerp( duskBot, k );
        } else
        {
            const k = stage( 0.8, 1.0, t );
            cTop.copy( duskTop ).lerp( nightTop, k ); cMid.copy( duskMid ).lerp( nightMid, k ); cBot.copy( duskBot ).lerp( nightBot, k );
        }

        // الغيوم/المطر بتغمّق السما شوية
        const overcast = this._weather.intensity * 0.6;
        cTop.lerp( new THREE.Color( "#3a4048" ), overcast );
        cMid.lerp( new THREE.Color( "#57616a" ), overcast );
        cBot.lerp( new THREE.Color( "#6b747c" ), overcast );

        this._sky.material.uniforms.uTop.value.copy( cTop );
        this._sky.material.uniforms.uMid.value.copy( cMid );
        this._sky.material.uniforms.uBottom.value.copy( cBot );
        this._sky.material.uniforms.uTime.value = this._clock.elapsedTime;
        this._sky.material.uniforms.uNightFactor.value = nightFactor;
        this.scene.fog.color.copy( cBot );

        // شوية تلألؤ خفيف عالنجوم عشان تبقى حية أكتر بدل ما تبقى ثابتة
        // (التلألؤ الأساسي دلوقتي بيتحسب لكل نجمة على حدة جوه الـ vertex
        // shader نفسه — ده بس عامل عام إضافي بيتحكم في وضوح الطبقة كلها).
        const twinkle = 0.9 + Math.sin( this._clock.elapsedTime * 0.6 ) * 0.06 + Math.sin( this._clock.elapsedTime * 1.7 + 1.3 ) * 0.04;
        this._stars.material.uniforms.uTime.value = this._clock.elapsedTime;
        this._stars.material.uniforms.uOpacity.value = nightFactor * 0.95 * twinkle * ( 1 - overcast * 0.7 );
        if ( this._starLayers ) this._starLayers.forEach( ( layer, index ) =>
        {
            layer.material.opacity = nightFactor * ( 0.65 + Math.sin( this._clock.elapsedTime * ( 1.1 + index ) ) * 0.12 ) * ( 1 - overcast * 0.7 );
        } );
        this._sunSprite.material.opacity = dayFactor;
        this._moonSprite.material.opacity = nightFactor * ( 1 - overcast * 0.6 );
        if ( this._rainbow ) this._rainbow.materials.forEach( material =>
        {
            material.opacity = dayFactor * Math.min( 0.82, 0.22 + this._weather.intensity * 0.7 );
        } );
        if ( this._cityLights ) this._cityLights.forEach( light => { light.material.opacity = nightFactor * 0.9; } );
        this._sky.material.uniforms.uSunDir.value.copy( this._sun.position ).normalize();
        this._sky.material.uniforms.uSeason.value = this._seasonIndex || 0;

        this._sun.intensity = ( 0.82 + Math.sin( this._clock.elapsedTime * 0.12 ) * 0.05 + dayFactor * 0.5 ) * ( 1 - overcast * 0.55 );
        this._sun.color.setHSL( 0.11 - dayFactor * 0.03, 0.7, 0.6 + dayFactor * 0.1 );
        // إضاءة القمر والـ ambient اترفعت بشكل واضح عشان الأشجار والعشب
        // يبانوا بوضوح بالليل من غير ما نضطر نرجع للنهار.
        this._moonLight.intensity = ( 0.12 + nightFactor * 0.42 ) * ( 1 - overcast * 0.45 );
        this._hemi.intensity = 0.28 + dayFactor * 0.3 + nightFactor * 0.12;
        this._fillLight.intensity = 0.08 + nightFactor * 0.12;
        if ( this._gardenGlow ) this._gardenGlow.intensity = 0.08 + nightFactor * 0.2;

        this._dayFactor = dayFactor;
        this._nightFactor = nightFactor;
    };

    // ================================================================
    // ---------- TerrainSystem ----------
    // ================================================================
    Garden3D.prototype._buildTerrain = function ( fieldW, fieldD, noise )
    {
        const scene = this.scene;
        const groundGeo = new THREE.PlaneGeometry( fieldW + 10, fieldD + 10, 90, 40 );
        groundGeo.rotateX( -Math.PI / 2 );
        const gpos = groundGeo.attributes.position;
        for ( let i = 0; i < gpos.count; i++ )
        {
            const x = gpos.getX( i ), z = gpos.getZ( i );
            gpos.setY( i, this._terrainHeight( x, z ) );
        }
        groundGeo.computeVertexNormals();
        const uvAttr = groundGeo.attributes.uv;
        for ( let i = 0; i < uvAttr.count; i++ )
        {
            uvAttr.setXY( i, uvAttr.getX( i ) * 16, uvAttr.getY( i ) * 7 );
        }
        const groundTex = makeGroundTexture( noise, 256 );
        groundTex.repeat.set( 1, 1 );
        // رجّعنا الأرض لأسلوب "لعبة" مسطّح وحيوي (Toon/Cel-shading) بدل
        // الواقعية الفوتوغرافية: تدرّج إضاءة بخطوات واضحة (gradientMap) وألوان
        // مشبّعة، فالحديقة تبقى شكلها مميز وهوية بصرية خاصة بيها مش محاولة
        // تقليد الواقع.
        const toonGradient = makeToonGradient( 4 );
        this._toonGradient = toonGradient;
        const groundMat = new THREE.MeshToonMaterial( { map: groundTex, gradientMap: toonGradient } );
        const ground = new THREE.Mesh( groundGeo, groundMat );
        ground.receiveShadow = true;
        scene.add( ground );
        this._ground = ground;
        this._groundBaseColor = new THREE.Color( 0x6f6a43 );
        this._groundWetColor = new THREE.Color( 0x9fae9a );
        this._groundSeasonColors = [ new THREE.Color( 0x6f8247 ), new THREE.Color( 0x806b3c ), new THREE.Color( 0x76543b ), new THREE.Color( 0x68736d ) ];

        // ممرات بين صفوف القطع لإحساس "أرض مزروعة"
        const pathMat = new THREE.MeshStandardMaterial( { color: 0x8a744f, roughness: 1 } );
        this._pathMat = pathMat;
        for ( let r = -1; r < ROWS; r += 2 )
        {
            const z = ( r - ( ROWS - 1 ) / 2 ) * SPACING + SPACING * 0.5;
            const strip = new THREE.Mesh( new THREE.PlaneGeometry( fieldW + 6, SPACING * 0.35 ), pathMat );
            strip.rotation.x = -Math.PI / 2;
            strip.position.set( 0, this._terrainHeight( 0, z ) + 0.02, z );
            strip.receiveShadow = true;
            scene.add( strip );
        }
    };

    Garden3D.prototype._buildRocks = function ( fieldW, fieldD )
    {
        const count = 40;
        const geoBase = new THREE.IcosahedronGeometry( 1, 0 );
        // نفس أسلوب الـ Cel-Shading بتاع الأرض عشان الهوية البصرية تبقى
        // متجانسة في كل حاجة — صخور بحواف واضحة وألوان مسطحة بدل واقعية.
        const mat = new THREE.MeshToonMaterial( { color: 0x9a958c, gradientMap: this._toonGradient, flatShading: true } );
        const mesh = new THREE.InstancedMesh( geoBase, mat, count );
        mesh.castShadow = true; mesh.receiveShadow = true;
        const dummy = new THREE.Object3D();
        let placed = 0, attempts = 0;
        while ( placed < count && attempts < count * 12 )
        {
            attempts++;
            const x = ( Math.random() - 0.5 ) * fieldW * 0.95;
            const z = ( Math.random() - 0.5 ) * fieldD * 0.95;
            // ابعد عن مراكز القطع عشان الصخور متطلعش فوق الأرض المزروعة
            const col = Math.round( x / SPACING + ( COLS - 1 ) / 2 );
            const row = Math.round( z / SPACING + ( ROWS - 1 ) / 2 );
            const nearestX = ( col - ( COLS - 1 ) / 2 ) * SPACING;
            const nearestZ = ( row - ( ROWS - 1 ) / 2 ) * SPACING;
            if ( Math.hypot( x - nearestX, z - nearestZ ) < PLOT_SIZE * 0.9 ) continue;
            const y = this._terrainHeight( x, z );
            const s = 0.12 + Math.random() * 0.22;
            dummy.position.set( x, y + s * 0.4, z );
            dummy.rotation.set( Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI );
            dummy.scale.set( s, s * ( 0.6 + Math.random() * 0.5 ), s );
            dummy.updateMatrix();
            mesh.setMatrixAt( placed, dummy.matrix );
            placed++;
        }
        mesh.count = placed;
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add( mesh );
        this._rocks = mesh;
    };

    Garden3D.prototype._buildFarmProps = function ( fieldW, fieldD )
    {
        const wood = new THREE.MeshStandardMaterial( { color: 0x765034, roughness: 0.92 } );
        const darkWood = new THREE.MeshStandardMaterial( { color: 0x4b3020, roughness: 1 } );
        const roofMat = new THREE.MeshStandardMaterial( { color: 0x9a4f32, roughness: 0.86 } );
        const metal = new THREE.MeshStandardMaterial( { color: 0x68675a, roughness: 0.8, metalness: 0.12 } );
        const straw = new THREE.MeshStandardMaterial( { color: 0xc99b45, roughness: 1 } );
        const props = new THREE.Group();
        const add = ( geometry, material, x, z, y, scale ) =>
        {
            const mesh = new THREE.Mesh( geometry, material );
            mesh.position.set( x, y === undefined ? this._terrainHeight( x, z ) : y, z );
            if ( scale ) mesh.scale.set( scale, scale, scale );
            mesh.castShadow = true; mesh.receiveShadow = true;
            props.add( mesh );
            return mesh;
        };

        const fenceGeo = new THREE.BoxGeometry( 0.12, 0.8, 0.12 );
        const railGeo = new THREE.BoxGeometry( 2.4, 0.1, 0.1 );
        for ( let i = 0; i < 15; i++ )
        {
            const x = -fieldW * 0.48 + i * fieldW * 0.068;
            add( fenceGeo, wood, x, -fieldD * 0.46, this._terrainHeight( x, -fieldD * 0.46 ) + 0.4 );
            add( fenceGeo, wood, x + 0.04, fieldD * 0.46, this._terrainHeight( x, fieldD * 0.46 ) + 0.4 );
        }
        for ( let i = 0; i < 6; i++ )
        {
            const z = -fieldD * 0.42 + i * fieldD * 0.17;
            add( fenceGeo, wood, -fieldW * 0.47, z, this._terrainHeight( -fieldW * 0.47, z ) + 0.4 );
            add( fenceGeo, wood, fieldW * 0.47, z, this._terrainHeight( fieldW * 0.47, z ) + 0.4 );
        }
        const bottomRail = add( railGeo, darkWood, 0, -fieldD * 0.46, this._terrainHeight( 0, -fieldD * 0.46 ) + 0.35 );
        bottomRail.rotation.y = 0;
        add( railGeo, darkWood, 0, fieldD * 0.46, this._terrainHeight( 0, fieldD * 0.46 ) + 0.35 );

        const barnX = fieldW * 0.62, barnZ = -fieldD * 0.62, barnY = this._terrainHeight( barnX, barnZ );
        add( new THREE.BoxGeometry( 4.8, 2.8, 3.4 ), new THREE.MeshStandardMaterial( { color: 0x9b5a3d, roughness: 0.9 } ), barnX, barnZ, barnY + 1.4 );
        add( new THREE.ConeGeometry( 3.1, 1.5, 4 ), roofMat, barnX, barnZ, barnY + 3.55 ).rotation.y = Math.PI * 0.25;
        add( new THREE.BoxGeometry( 0.95, 1.8, 0.08 ), darkWood, barnX, barnZ - 1.72, barnY + 0.9 );

        const wellX = fieldW * 0.58, wellZ = fieldD * 0.05, wellY = this._terrainHeight( wellX, wellZ );
        add( new THREE.CylinderGeometry( 0.8, 0.9, 0.65, 10 ), stoneMaterial(), wellX, wellZ, wellY + 0.32 );
        add( new THREE.CylinderGeometry( 0.06, 0.06, 2.5, 6 ), wood, wellX, wellZ, wellY + 1.45 );
        add( new THREE.CylinderGeometry( 0.06, 0.06, 2.5, 6 ), wood, wellX, wellZ, wellY + 1.45 ).rotation.z = Math.PI / 2;
        add( new THREE.CylinderGeometry( 0.58, 0.58, 0.08, 12 ), metal, wellX, wellZ, wellY + 0.68 );

        for ( let i = 0; i < 5; i++ )
        {
            const x = fieldW * ( 0.48 + i * 0.045 ), z = -fieldD * 0.52 + ( i % 2 ) * 0.5;
            add( new THREE.CylinderGeometry( 0.38, 0.44, 0.55, 10 ), straw, x, z, this._terrainHeight( x, z ) + 0.28, 1 );
        }
        for ( let i = 0; i < 7; i++ )
        {
            const x = fieldW * 0.48 + ( i % 4 ) * 0.55, z = fieldD * 0.28 + Math.floor( i / 4 ) * 0.45;
            add( new THREE.BoxGeometry( 0.48, 0.36, 0.48 ), wood, x, z, this._terrainHeight( x, z ) + 0.18 );
        }
        this.scene.add( props );

        function stoneMaterial () { return new THREE.MeshStandardMaterial( { color: 0x77776b, roughness: 1 } ); }
    };

    Garden3D.prototype._buildWorldRegions = function ( fieldW, fieldD, worldW, worldD )
    {
        const terrainHeight = this._terrainHeight;
        const forestZ = -fieldD * 0.78;
        const forestDepth = fieldD * 0.9;
        const grassMat = new THREE.MeshStandardMaterial( { color: 0x4d713d, roughness: 1 } );
        const roadMat = new THREE.MeshStandardMaterial( { color: 0x9a744e, roughness: 1 } );
        const woodMat = new THREE.MeshStandardMaterial( { color: 0x65462d, roughness: 0.95 } );
        const mossMat = new THREE.MeshStandardMaterial( { color: 0x56724a, roughness: 1 } );
        const region = new THREE.Group();
        const add = ( geo, mat, x, y, z, scale ) =>
        {
            const mesh = new THREE.Mesh( geo, mat );
            mesh.position.set( x, y === undefined ? this._terrainHeight( x, z ) : y, z );
            if ( scale ) mesh.scale.setScalar( scale );
            mesh.castShadow = true; mesh.receiveShadow = true; region.add( mesh ); return mesh;
        };

        const pathPoints = [ [ fieldW * 0.2, fieldD * 0.52 ], [ fieldW * 0.1, fieldD * 0.15 ], [ 1, -fieldD * 0.35 ], [ -fieldW * 0.08, forestZ ], [ fieldW * 0.02, forestZ - forestDepth * 0.75 ], [ fieldW * 0.15, -worldD * 0.44 ] ];
        for ( let i = 0; i < pathPoints.length - 1; i++ )
        {
            const a = pathPoints[ i ], b = pathPoints[ i + 1 ];
            const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ];
            const length = Math.hypot( dx, dz );
            const strip = add( new THREE.PlaneGeometry( 3.1 + i * 0.28, length ), roadMat, ( a[ 0 ] + b[ 0 ] ) / 2, 0, ( a[ 1 ] + b[ 1 ] ) / 2 );
            strip.rotation.x = -Math.PI / 2; strip.rotation.z = -Math.atan2( dx, dz ); strip.position.y += 0.035;
        }

        const forestFloor = add( new THREE.CircleGeometry( fieldW * 0.72, 32 ), grassMat, 0, 0, forestZ - forestDepth * 0.35 );
        forestFloor.scale.y = forestDepth / fieldW * 0.8;
        forestFloor.rotation.x = -Math.PI / 2;
        const postGeo = new THREE.CylinderGeometry( 0.12, 0.16, 1.15, 6 );
        const railGeo = new THREE.BoxGeometry( 2.8, 0.12, 0.12 );
        for ( let i = 0; i < 18; i++ )
        {
            const x = -fieldW * 0.72 + i * fieldW * 0.085 + Math.sin( i * 2.3 ) * 0.18;
            add( postGeo, woodMat, x, this._terrainHeight( x, forestZ ), forestZ );
            if ( i < 17 )
            {
                const rail = add( railGeo, woodMat, x + fieldW * 0.042, this._terrainHeight( x, forestZ ) + 0.48, forestZ + Math.sin( i ) * 0.08 );
                rail.rotation.y = Math.sin( i * 1.7 ) * 0.035;
            }
        }

        const treeTrunk = new THREE.MeshStandardMaterial( { color: 0x513622, roughness: 1 } );
        const leafMats = [ 0x315c35, 0x477b3e, 0x638e47, 0x806c38 ].map( color => new THREE.MeshStandardMaterial( { color, roughness: 0.9 } ) );
        for ( let i = 0; i < 26; i++ )
        {
            const x = ( ( i * 17 ) % 100 ) / 100 * fieldW * 1.45 - fieldW * 0.72;
            const z = forestZ - ( ( i * 29 ) % 100 ) / 100 * forestDepth;
            if ( Math.abs( x ) < fieldW * 0.15 && z < forestZ - forestDepth * 0.45 ) continue;
            const h = 2.2 + ( i % 7 ) * 0.34, r = 0.55 + ( i % 5 ) * 0.12;
            addForestTree( x, z, h, r, leafMats[ i % leafMats.length ], i % 3 );
        }
        const ancient = new THREE.Group();
        const ancientX = -fieldW * 0.16, ancientZ = forestZ - forestDepth * 0.42, ancientY = this._terrainHeight( ancientX, ancientZ );
        const ancientTrunk = new THREE.Mesh( new THREE.CylinderGeometry( 0.82, 1.35, 5.2, 12 ), treeTrunk );
        ancientTrunk.position.y = 2.6; ancient.add( ancientTrunk );
        for ( let i = 0; i < 7; i++ )
        {
            const branch = new THREE.Mesh( new THREE.CylinderGeometry( 0.12 + ( 6 - i ) * 0.035, 0.3, 3.1 + ( i % 3 ) * 0.8, 7 ), treeTrunk );
            branch.position.set( Math.cos( i * 1.8 ) * 1.25, 4.1 + ( i % 3 ) * 0.55, Math.sin( i * 1.8 ) * 1.25 );
            branch.rotation.z = Math.cos( i * 2.1 ) * 0.58; branch.rotation.x = Math.sin( i * 1.4 ) * 0.48; ancient.add( branch );
        }
        for ( let i = 0; i < 10; i++ )
        {
            const root = new THREE.Mesh( new THREE.CylinderGeometry( 0.08, 0.3, 2.4, 7 ), treeTrunk );
            root.position.set( Math.cos( i * 0.63 ) * 1.0, 0.35, Math.sin( i * 0.63 ) * 1.0 ); root.rotation.z = Math.cos( i * 0.63 ) * 0.9; root.rotation.x = Math.sin( i * 0.63 ) * 0.9; ancient.add( root );
        }
        for ( let i = 0; i < 17; i++ )
        {
            const crown = new THREE.Mesh( new THREE.IcosahedronGeometry( 1.15 + ( i % 4 ) * 0.24, 1 ), leafMats[ i % 3 ] );
            crown.position.set( Math.cos( i * 2.4 ) * ( 1.4 + i % 3 * 0.35 ), 5.2 + ( i % 5 ) * 0.45, Math.sin( i * 2.4 ) * ( 1.2 + i % 4 * 0.3 ) ); ancient.add( crown );
        }
        ancient.position.set( ancientX, ancientY, ancientZ ); ancient.traverse( o => { o.castShadow = true; o.receiveShadow = true; } ); region.add( ancient ); this._ancientTree = ancient;
        for ( let i = 0; i < 9; i++ )
        {
            const x = -fieldW * 0.62 + ( i % 5 ) * 3.1, z = forestZ - 4 - Math.floor( i / 5 ) * 5;
            const log = add( new THREE.CylinderGeometry( 0.18 + i % 3 * 0.05, 0.24, 2.8 + i % 4 * 0.6, 7 ), treeTrunk, x, terrainHeight( x, z ) + 0.18, z );
            log.rotation.z = Math.PI / 2; log.rotation.y = i * 0.7;
            if ( i < 5 ) add( new THREE.CylinderGeometry( 0.16, 0.21, 0.55, 7 ), mossMat, x + 0.2, terrainHeight( x, z ) + 0.33, z + 0.08 );
        }
        const shrubGeo = new THREE.IcosahedronGeometry( 0.38, 1 );
        for ( let i = 0; i < 24; i++ )
        {
            const x = -fieldW * 0.7 + ( i * 13 % 100 ) / 100 * fieldW * 1.4;
            const z = forestZ - 2 - ( i * 19 % 100 ) / 100 * forestDepth;
            add( shrubGeo, i % 3 ? mossMat : leafMats[ 2 ], x, terrainHeight( x, z ) + 0.28, z, 0.7 + ( i % 4 ) * 0.14 );
        }

        const cityMat = new THREE.MeshStandardMaterial( { color: 0x526274, roughness: 0.95 } );
        const villageMats = [ 0x8d674b, 0x6d7d80, 0x9a8b67, 0x69715e ].map( color => new THREE.MeshStandardMaterial( { color, roughness: 0.95 } ) );
        const roofCity = new THREE.MeshStandardMaterial( { color: 0x60433a, roughness: 1 } );
        for ( let i = 0; i < 8; i++ )
        {
            const x = -worldW * 0.38 + ( i % 9 ) * 4.3, z = -worldD * 0.43 - Math.floor( i / 9 ) * 3;
            const h = 3 + ( i * 7 ) % 7;
            addCityBuilding( x, z, h, villageMats[ i % villageMats.length ], i );
        }
        const settlementBands = [
            { count: 5, x: -fieldW * 0.9, z: -fieldD * 0.1, spread: 12, scale: 0.72 },
            { count: 7, x: fieldW * 0.92, z: -fieldD * 0.45, spread: 16, scale: 0.9 },
            { count: 9, x: -worldW * 0.18, z: -worldD * 0.33, spread: 26, scale: 1.15 }
        ];
        settlementBands.forEach( ( band, bandIndex ) =>
        {
            for ( let i = 0; i < band.count; i++ )
            {
                const x = band.x + Math.sin( i * 1.71 + bandIndex ) * band.spread + ( i % 4 ) * 2.2;
                const z = band.z - Math.cos( i * 1.13 ) * band.spread * 0.62;
                const h = ( 2.2 + ( i * 3 ) % 4 ) * band.scale;
                addCityBuilding( x, z, h, villageMats[ ( i + bandIndex ) % villageMats.length ], i + bandIndex * 3 );
            }
        } );
        const windowMat = new THREE.MeshBasicMaterial( { color: 0xffc86b, transparent: true, opacity: 0 } );
        this._cityLights = [];
        for ( let i = 0; i < 38; i++ )
        {
            const x = -worldW * 0.55 + ( i * 17 % 100 ) / 100 * worldW * 0.82;
            const z = -worldD * 0.31 - ( i % 5 ) * 2.6;
            const light = add( new THREE.PlaneGeometry( 0.22, 0.3 ), windowMat, x, terrainHeight( x, z ) + 1.1 + ( i % 3 ) * 0.5, z );
            light.rotation.y = Math.PI; this._cityLights.push( light );
        }
        for ( let i = 0; i < 5; i++ )
        {
            const x = -worldW * 0.32 + i * 12, z = -worldD * 0.29 - ( i % 2 ) * 7;
            add( new THREE.CylinderGeometry( 0.8, 0.95, 3.6, 10 ), cityMat, x, terrainHeight( x, z ) + 1.8, z );
            add( new THREE.CylinderGeometry( 1.15, 1.15, 0.6, 10 ), cityMat, x, terrainHeight( x, z ) + 3.9, z );
            add( new THREE.CylinderGeometry( 0.08, 0.08, 3.6, 5 ), woodMat, x - 0.8, terrainHeight( x, z ) + 1.8, z );
        }
        const mountainMat = new THREE.MeshStandardMaterial( { color: 0x65777a, roughness: 1, fog: true } );
        for ( let i = 0; i < 7; i++ ) add( new THREE.ConeGeometry( 7 + i % 3 * 2, 13 + i % 4 * 3, 7 ), mountainMat, -worldW * 0.5 + i * 15, 6, -worldD * 0.5, 1 );
        this.scene.add( region );

        function addForestTree ( x, z, h, r, material, variant )
        {
            const tree = new THREE.Group();
            const trunk = new THREE.Mesh( new THREE.CylinderGeometry( r * 0.11, r * 0.17, h * 0.55, 7 ), treeTrunk ); trunk.position.y = h * 0.275; tree.add( trunk );
            const crownCount = variant === 1 ? 2 : 3;
            for ( let j = 0; j < crownCount; j++ )
            {
                const crownGeometry = variant === 2
                    ? new THREE.ConeGeometry( r * ( 0.8 + j * 0.18 ), r * ( 1.25 + j * 0.12 ), 7 )
                    : new THREE.IcosahedronGeometry( r * ( 0.8 + j * 0.16 ), 1 );
                const crown = new THREE.Mesh( crownGeometry, material );
                crown.position.set( ( j - ( crownCount - 1 ) / 2 ) * r * 0.3, h * ( 0.43 + j * 0.12 ), ( j % 2 ) * r * 0.25 );
                if ( variant === 2 ) crown.rotation.y = j * 0.8;
                tree.add( crown );
            }
            tree.position.set( x, terrainHeight( x, z ), z ); tree.rotation.y = ( x + z ) * 0.13; tree.scale.setScalar( 0.78 + ( Math.abs( x * 3 + z ) % 48 ) / 100 ); tree.traverse( o => { o.castShadow = true; o.receiveShadow = true; } ); region.add( tree );
        }
        function addCityBuilding ( x, z, h, mat, variant )
        {
            const width = variant % 3 === 0 ? 3.8 : 2.7, depth = variant % 2 ? 2.4 : 3.2;
            add( new THREE.BoxGeometry( width, h, depth ), mat, x, h / 2 + terrainHeight( x, z ), z );
            if ( variant % 3 !== 1 ) add( new THREE.ConeGeometry( width * 0.72, variant % 2 ? 1.2 : 0.8, variant % 2 ? 4 : 6 ), roofCity, x, h + terrainHeight( x, z ) + 0.45, z ).rotation.y = Math.PI * 0.25;
            if ( variant % 4 === 0 ) add( new THREE.BoxGeometry( width * 0.5, 0.08, 0.7 ), roofCity, x, h * 0.62 + terrainHeight( x, z ), z - depth * 0.55 );
            if ( variant % 3 === 0 ) add( new THREE.BoxGeometry( width * 0.82, 0.16, 0.62 ), woodMat, x, terrainHeight( x, z + depth * 0.55 ) + 0.18, z + depth * 0.55 );
        }
    };

    // ================================================================
    // ---------- Soil plots ----------
    // ================================================================
    Garden3D.prototype._buildSoil = function ()
    {
        const soilGeo = new THREE.BoxGeometry( PLOT_SIZE, 0.14, PLOT_SIZE, 1, 1, 1 );
        const soilMat = new THREE.MeshStandardMaterial( { color: 0x8a5c3a, roughness: 0.95, vertexColors: false } );
        const soil = new THREE.InstancedMesh( soilGeo, soilMat, this.cellCount );
        soil.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
        soil.castShadow = false; soil.receiveShadow = true;
        const dummy = new THREE.Object3D();
        const colorEmpty = new THREE.Color( "#6f4a30" );
        for ( let i = 0; i < this.cellCount; i++ )
        {
            const p = this._plotPos[ i ];
            dummy.position.set( p.x, p.y + 0.06, p.z );
            dummy.rotation.y = ( ( i * 37 ) % 7 ) * 0.01;
            dummy.updateMatrix();
            soil.setMatrixAt( i, dummy.matrix );
            soil.setColorAt( i, colorEmpty );
        }
        soil.instanceMatrix.needsUpdate = true;
        if ( soil.instanceColor ) soil.instanceColor.needsUpdate = true;
        this.scene.add( soil );
        this._soil = soil;
        this._colorEmpty = colorEmpty;
        this._colorPlantable = new THREE.Color( "#caa15a" );
        this._colorPlanted = new THREE.Color( "#4a3322" );
        this._colorHover = new THREE.Color( "#f2c469" );
    };

    // ================================================================
    // ---------- TreeSystem ----------
    // ================================================================
    Garden3D.prototype._buildTreeInstances = function ( height, canopyR, canopyColor, extraLayer )
    {
        const trunkH = height * 0.42;
        const geoms = [];
        const trunk = new THREE.CylinderGeometry( canopyR * 0.09, canopyR * 0.14, trunkH, 6 );
        trunk.translate( 0, trunkH / 2, 0 );
        paintGeo( trunk, 0x6b4a2e );
        geoms.push( trunk );

        // فروع بسيطة بارزة من الجذع عشان الشكل مايبقاش عمود ملط
        for ( let b = 0; b < 3; b++ )
        {
            const branch = new THREE.CylinderGeometry( canopyR * 0.02, canopyR * 0.045, trunkH * 0.42, 5 );
            const ang = ( b / 3 ) * Math.PI * 2 + 0.6;
            branch.translate( 0, trunkH * 0.42 / 2, 0 );
            branch.rotateZ( Math.PI / 3.1 );
            branch.rotateY( ang );
            branch.translate( 0, trunkH * 0.66, 0 );
            paintGeo( branch, 0x5f4128 );
            geoms.push( branch );
        }

        function cone ( r, h, y, xOff, zOff )
        {
            const g = new THREE.ConeGeometry( r, h, 7 );
            g.translate( xOff || 0, y, zOff || 0 );
            paintGeo( g, canopyColor );
            return g;
        }
        function paintGeo ( g, hex )
        {
            const c = new THREE.Color( hex );
            const count = g.attributes.position.count;
            const arr = new Float32Array( count * 3 );
            for ( let i = 0; i < count; i++ ) { arr[ i * 3 ] = c.r; arr[ i * 3 + 1 ] = c.g; arr[ i * 3 + 2 ] = c.b; }
            g.setAttribute( "color", new THREE.BufferAttribute( arr, 3 ) );
        }

        // كتل تاج متعددة ومزاحة قليلًا عشان الشكل يبان طبيعي مش مخروط واحد مثالي
        geoms.push( cone( canopyR, height * 0.55, trunkH + height * 0.20, 0, 0 ) );
        geoms.push( cone( canopyR * 0.6, height * 0.4, trunkH + height * 0.30, canopyR * 0.35, canopyR * 0.15 ) );
        geoms.push( cone( canopyR * 0.55, height * 0.38, trunkH + height * 0.28, -canopyR * 0.3, -canopyR * 0.2 ) );
        geoms.push( cone( canopyR * 0.78, height * 0.5, trunkH + height * 0.42, 0, 0 ) );
        if ( extraLayer ) geoms.push( cone( canopyR * 0.55, height * 0.42, trunkH + height * 0.62, 0, 0 ) );

        const mergeFn = THREE.BufferGeometryUtils && ( THREE.BufferGeometryUtils.mergeGeometries || THREE.BufferGeometryUtils.mergeBufferGeometries );
        let merged;
        try
        {
            if ( !mergeFn ) throw new Error( "no mergeFn" );
            merged = mergeFn( geoms, false );
            if ( !merged ) throw new Error( "mergeFn returned nothing" );
        }
        catch ( e )
        {
            // بعض نسخ BufferGeometryUtils اللي بتيجي من الـ CDN بترمي خطأ
            // (زي "Cannot read properties of undefined (reading 'mergeBufferAttributes')")
            // فبنرجع تلقائيًا لدالتنا الاحتياطية عشان الرندر ما يوقفش.
            merged = mergeGeometriesFallback( geoms );
        }

        // إضاءة ذاتية خفيفة (emissive) بلون التاج عشان الشجرة تبقى واضحة
        // ومتميزة عن الضلمة من غير ما تعتمد بالكامل على إضاءة السين.
        const emissiveTint = new THREE.Color( canopyColor ).multiplyScalar( 0.22 );
        const material = new THREE.MeshStandardMaterial( {
            vertexColors: true, roughness: 0.8, metalness: 0.02,
            emissive: emissiveTint, emissiveIntensity: 0.6
        } );
        const timeUniform = { value: 0 };
        const windUniform = { value: 0.15 };
        const seasonUniform = { value: 0 };
        material.onBeforeCompile = ( shader ) =>
        {
            shader.uniforms.uTime = timeUniform;
            shader.uniforms.uWind = windUniform;
            shader.uniforms.uSeason = seasonUniform;
            shader.vertexShader = "attribute float aPhase;\nattribute float aHue;\nuniform float uTime;\nuniform float uWind;\nuniform float uSeason;\n" + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
                "#include <begin_vertex>",
                `#include <begin_vertex>
                float heightFactor = clamp( position.y / ${ height.toFixed( 3 ) }, 0.0, 1.0 );
                heightFactor *= heightFactor;
                float windAmp = 0.04 + uWind * 0.22;
                float sway = sin( uTime * ( 1.2 + uWind * 1.6 ) + aPhase + heightFactor * 2.0 ) * windAmp * heightFactor;
                float sway2 = cos( uTime * ( 0.9 + uWind * 1.1 ) + aPhase * 1.7 ) * windAmp * 0.55 * heightFactor;
                transformed.x += sway;
                transformed.z += sway2;`
            );
            shader.vertexShader = shader.vertexShader.replace(
                "#include <color_vertex>",
                `#include <color_vertex>
                vec3 springTint = vec3( 0.72, 1.0, 0.56 );
                vec3 summerTint = vec3( 0.48, 0.82, 0.38 );
                vec3 autumnTint = vec3( 1.0, 0.48, 0.12 );
                vec3 winterTint = vec3( 0.62, 0.72, 0.68 );
                vec3 seasonTint = uSeason < 1.0 ? mix( springTint, summerTint, uSeason ) :
                    uSeason < 2.0 ? mix( summerTint, autumnTint, uSeason - 1.0 ) : mix( autumnTint, winterTint, uSeason - 2.0 );
                vColor.rgb *= mix( vec3( 0.82 ), seasonTint, 0.46 );
                vColor.rgb *= ( 0.78 + aHue * 0.36 );`
            );
            material.userData.shader = shader;
        };
        material.userData.timeUniform = timeUniform;
        material.userData.windUniform = windUniform;

        const mesh = new THREE.InstancedMesh( merged, material, this.cellCount );
        mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.count = this.cellCount;

        const phase = new Float32Array( this.cellCount );
        const hue = new Float32Array( this.cellCount );
        for ( let i = 0; i < this.cellCount; i++ )
        {
            phase[ i ] = ( i * 12.9898 ) % ( Math.PI * 2 );
            hue[ i ] = ( ( i * 53 ) % 97 ) / 97;
        }
        merged.setAttribute( "aPhase", new THREE.InstancedBufferAttribute( phase, 1 ) );
        merged.setAttribute( "aHue", new THREE.InstancedBufferAttribute( hue, 1 ) );

        const dummy = new THREE.Object3D();
        for ( let i = 0; i < this.cellCount; i++ )
        {
            dummy.position.set( 0, 0, 0 );
            dummy.scale.set( 0.0001, 0.0001, 0.0001 );
            dummy.updateMatrix();
            mesh.setMatrixAt( i, dummy.matrix );
        }
        mesh.instanceMatrix.needsUpdate = true;

        function mergeGeometriesFallback ( list )
        {
            let vCount = 0, iCount = 0;
            list.forEach( g => { vCount += g.attributes.position.count; if ( g.index ) iCount += g.index.count; } );
            const positions = new Float32Array( vCount * 3 );
            const normals = new Float32Array( vCount * 3 );
            const colors = new Float32Array( vCount * 3 );
            const indices = [];
            let vOff = 0, base = 0;
            list.forEach( g =>
            {
                if ( !g.attributes.normal ) g.computeVertexNormals();
                positions.set( g.attributes.position.array, vOff * 3 );
                normals.set( g.attributes.normal.array, vOff * 3 );
                colors.set( g.attributes.color.array, vOff * 3 );
                if ( g.index ) { for ( let k = 0; k < g.index.count; k++ ) indices.push( g.index.array[ k ] + base ); }
                base += g.attributes.position.count;
                vOff += g.attributes.position.count;
            } );
            const bg = new THREE.BufferGeometry();
            bg.setAttribute( "position", new THREE.BufferAttribute( positions, 3 ) );
            bg.setAttribute( "normal", new THREE.BufferAttribute( normals, 3 ) );
            bg.setAttribute( "color", new THREE.BufferAttribute( colors, 3 ) );
            if ( indices.length ) bg.setIndex( indices );
            return bg;
        }

        return { mesh, height, timeUniform, windUniform, seasonUniform };
    };

    // ================================================================
    // ---------- GrassSystem ----------
    // ================================================================
    Garden3D.prototype._buildGrass = function ( fieldW, fieldD, count )
    {
        const bladeGeo = new THREE.PlaneGeometry( 0.09, 0.5, 1, 3 );
        bladeGeo.translate( 0, 0.25, 0 );
        const material = new THREE.MeshStandardMaterial( {
            color: 0x6fac47, roughness: 0.95, side: THREE.DoubleSide,
            emissive: 0x1c2e10, emissiveIntensity: 0.5
        } );
        const timeUniform = { value: 0 };
        const windUniform = { value: 0.15 };
        const windDirUniform = { value: 0 };
        const seasonUniform = { value: 0 };
        material.onBeforeCompile = ( shader ) =>
        {
            shader.uniforms.uTime = timeUniform;
            shader.uniforms.uWind = windUniform;
            shader.uniforms.uWindDir = windDirUniform;
            shader.uniforms.uSeason = seasonUniform;
            shader.vertexShader = "attribute float aPhase;\nuniform float uTime;\nuniform float uWind;\nuniform float uWindDir;\nuniform float uSeason;\n" + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
                "#include <begin_vertex>",
                `#include <begin_vertex>
                float hf = clamp( position.y / 0.5, 0.0, 1.0 );
                float amp = ( 0.08 + uWind * 0.35 ) * hf * hf;
                transformed.x += sin( uTime * ( 1.6 + uWind * 2.0 ) + aPhase + uWindDir ) * amp;
                transformed.z += cos( uWindDir ) * amp * 0.4;`
            );
            shader.fragmentShader = "uniform float uSeason;\n" + shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace( "#include <color_fragment>", `#include <color_fragment>
                diffuseColor.rgb *= mix( vec3( 0.82, 1.0, 0.55 ), vec3( 0.62, 0.72, 0.65 ), smoothstep( 1.0, 3.0, uSeason ) );` );
        };
        const mesh = new THREE.InstancedMesh( bladeGeo, material, count );
        mesh.castShadow = false; mesh.receiveShadow = false;
        const dummy = new THREE.Object3D();
        const phase = new Float32Array( count );
        for ( let i = 0; i < count; i++ )
        {
            const x = ( Math.random() - 0.5 ) * fieldW * 0.98;
            const z = ( Math.random() - 0.5 ) * fieldD * 0.98;
            const y = this._terrainHeight( x, z );
            dummy.position.set( x, y, z );
            dummy.rotation.y = Math.random() * Math.PI;
            const s = 0.6 + Math.random() * 0.8;
            dummy.scale.set( s, s * ( 0.7 + Math.random() * 0.6 ), s );
            dummy.updateMatrix();
            mesh.setMatrixAt( i, dummy.matrix );
            phase[ i ] = Math.random() * Math.PI * 2;
        }
        bladeGeo.setAttribute( "aPhase", new THREE.InstancedBufferAttribute( phase, 1 ) );
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add( mesh );
        this._grass = { mesh, timeUniform, windUniform, windDirUniform, seasonUniform };
    };

    // ================================================================
    // ---------- FlowerSystem: ورد ملوّن منتشر بين العشب ----------
    // بنبني وردة واحدة (ساق + قلب أصفر + 5 بتلات) بألوان مرسومة على
    // الـ vertices مباشرة (زي شكل الشجر بالظبط)، وبعدين بنعمل InstancedMesh
    // واحدة لكل لون عشان نضمن التوافق مع نسخة three.js اللي متحمّلة (r128)
    // من غير ما نعتمد على instanceColor اللي مش متاحة في النسخة دي.
    // ================================================================
    Garden3D.prototype._buildFlowers = function ( fieldW, fieldD, totalCount )
    {
        if ( !totalCount ) return;
        const palette = [ 0xe6567a, 0xf2a6c4, 0xb377e0, 0xf5d76e, 0xf6f1e6 ];
        const stemColor = 0x3f7a3f;
        const centerColor = 0xf3c94a;

        function paint ( g, hex )
        {
            const c = new THREE.Color( hex );
            const count = g.attributes.position.count;
            const arr = new Float32Array( count * 3 );
            for ( let i = 0; i < count; i++ ) { arr[ i * 3 ] = c.r; arr[ i * 3 + 1 ] = c.g; arr[ i * 3 + 2 ] = c.b; }
            g.setAttribute( "color", new THREE.BufferAttribute( arr, 3 ) );
        }

        function buildOneFlowerGeometry ( petalColor )
        {
            const parts = [];
            const stem = new THREE.CylinderGeometry( 0.012, 0.018, 0.22, 5 );
            stem.translate( 0, 0.11, 0 );
            paint( stem, stemColor );
            parts.push( stem );

            const center = new THREE.SphereGeometry( 0.035, 6, 5 );
            center.translate( 0, 0.235, 0 );
            paint( center, centerColor );
            parts.push( center );

            const petalCount = 5;
            for ( let p = 0; p < petalCount; p++ )
            {
                const petal = new THREE.SphereGeometry( 0.05, 6, 5 );
                petal.scale( 1, 0.45, 0.6 );
                const ang = ( p / petalCount ) * Math.PI * 2;
                petal.translate( 0, 0.235, 0.06 );
                petal.rotateY( ang );
                paint( petal, petalColor );
                parts.push( petal );
            }

            const mergeFn = THREE.BufferGeometryUtils && ( THREE.BufferGeometryUtils.mergeGeometries || THREE.BufferGeometryUtils.mergeBufferGeometries );
            try
            {
                if ( !mergeFn ) throw new Error( "no mergeFn" );
                const merged = mergeFn( parts, false );
                if ( !merged ) throw new Error( "empty" );
                return merged;
            }
            catch ( e )
            {
                // نفس فولباك دمج الأشجار بالظبط، عشان لو مكتبة الـ CDN
                // فشلت تفضل الورد شغال برضه.
                let vCount = 0;
                parts.forEach( g => { vCount += g.attributes.position.count; } );
                const positions = new Float32Array( vCount * 3 );
                const normals = new Float32Array( vCount * 3 );
                const colors = new Float32Array( vCount * 3 );
                let vOff = 0;
                parts.forEach( g =>
                {
                    if ( !g.attributes.normal ) g.computeVertexNormals();
                    positions.set( g.attributes.position.array, vOff * 3 );
                    normals.set( g.attributes.normal.array, vOff * 3 );
                    colors.set( g.attributes.color.array, vOff * 3 );
                    vOff += g.attributes.position.count;
                } );
                const bg = new THREE.BufferGeometry();
                bg.setAttribute( "position", new THREE.BufferAttribute( positions, 3 ) );
                bg.setAttribute( "normal", new THREE.BufferAttribute( normals, 3 ) );
                bg.setAttribute( "color", new THREE.BufferAttribute( colors, 3 ) );
                return bg;
            }
        }

        const groups = [];
        const perColor = Math.max( 4, Math.round( totalCount / palette.length ) );
        const timeUniform = { value: 0 };
        const windUniform = { value: 0.15 };

        palette.forEach( ( hex ) =>
        {
            const geo = buildOneFlowerGeometry( hex );
            const material = new THREE.MeshStandardMaterial( {
                vertexColors: true, roughness: 0.7, metalness: 0.02,
                emissive: new THREE.Color( hex ).multiplyScalar( 0.28 ), emissiveIntensity: 0.7
            } );
            material.onBeforeCompile = ( shader ) =>
            {
                shader.uniforms.uTime = timeUniform;
                shader.uniforms.uWind = windUniform;
                shader.vertexShader = "attribute float aPhase;\nuniform float uTime;\nuniform float uWind;\n" + shader.vertexShader;
                shader.vertexShader = shader.vertexShader.replace(
                    "#include <begin_vertex>",
                    `#include <begin_vertex>
                    float fHf = clamp( position.y / 0.24, 0.0, 1.0 );
                    float fAmp = ( 0.02 + uWind * 0.05 ) * fHf;
                    transformed.x += sin( uTime * 1.6 + aPhase ) * fAmp;
                    transformed.z += cos( uTime * 1.3 + aPhase * 1.4 ) * fAmp;`
                );
            };
            const mesh = new THREE.InstancedMesh( geo, material, perColor );
            mesh.castShadow = true; mesh.receiveShadow = true;
            const dummy = new THREE.Object3D();
            const phase = new Float32Array( perColor );
            for ( let i = 0; i < perColor; i++ )
            {
                const x = ( Math.random() - 0.5 ) * fieldW * 0.96;
                const z = ( Math.random() - 0.5 ) * fieldD * 0.96;
                const y = this._terrainHeight( x, z );
                dummy.position.set( x, y, z );
                dummy.rotation.y = Math.random() * Math.PI * 2;
                const s = 0.85 + Math.random() * 0.5;
                dummy.scale.set( s, s, s );
                dummy.updateMatrix();
                mesh.setMatrixAt( i, dummy.matrix );
                phase[ i ] = Math.random() * Math.PI * 2;
            }
            geo.setAttribute( "aPhase", new THREE.InstancedBufferAttribute( phase, 1 ) );
            mesh.instanceMatrix.needsUpdate = true;
            this.scene.add( mesh );
            groups.push( { mesh, timeUniform, windUniform } );
        } );

        this._flowers = { groups, timeUniform, windUniform };
    };

    // ================================================================
    // ---------- Clouds / Birds ----------
    // ================================================================
    Garden3D.prototype._buildClouds = function ( fieldW )
    {
        const tex = makeGlowTexture( "rgba(255,244,230,0.9)", "rgba(255,244,230,0)" );
        const mat = new THREE.SpriteMaterial( { map: tex, transparent: true, opacity: 0.55, depthWrite: false } );
        const clouds = [];
        for ( let i = 0; i < 9; i++ )
        {
            const s = new THREE.Sprite( mat.clone() );
            const scale = 14 + Math.random() * 20;
            s.scale.set( scale * 1.8, scale, 1 );
            s.position.set( ( Math.random() - 0.5 ) * fieldW * 2.2, 16 + Math.random() * 8, -20 - Math.random() * 40 );
            s.material.opacity = 0.35 + Math.random() * 0.3;
            this.scene.add( s );
            clouds.push( { sprite: s, speed: 0.15 + Math.random() * 0.25, baseOpacity: s.material.opacity } );
        }
        this._clouds = clouds;
        this._cloudBoundX = fieldW * 1.3;
    };

    Garden3D.prototype._buildRainbow = function ( fieldW, fieldD )
    {
        const colors = [ 0xe85d75, 0xf29d49, 0xf2d35e, 0x70b86d, 0x5da9d6, 0x7771ba ];
        const group = new THREE.Group();
        const materials = [];
        colors.forEach( ( color, index ) =>
        {
            const radius = 7.2 + index * 0.22;
            const points = [];
            for ( let step = 0; step <= 28; step++ )
            {
                const angle = Math.PI * step / 28;
                points.push( new THREE.Vector3( Math.cos( angle ) * radius, 8 + Math.sin( angle ) * radius, 0 ) );
            }
            const line = new THREE.Line( new THREE.BufferGeometry().setFromPoints( points ), new THREE.LineBasicMaterial( {
                color, transparent: true, opacity: 0, depthWrite: false
            } ) );
            line.position.z = -fieldD * 0.78;
            group.add( line );
            materials.push( line.material );
        } );
        group.position.x = fieldW * 0.08;
        this.scene.add( group );
        this._rainbow = { group, materials };
    };

    Garden3D.prototype._buildBirds = function ( fieldW, fieldD, count )
    {
        const wing = new THREE.BufferGeometry();
        // شكل "V" بسيط بيبقى الطائر: مثلثين مسطحين
        const v = new Float32Array( [
            -0.5, 0, 0, 0, 0, -0.35, 0, 0, 0.28,
            0.5, 0, 0, 0, 0, -0.35, 0, 0, 0.28
        ] );
        wing.setAttribute( "position", new THREE.BufferAttribute( v, 3 ) );
        wing.setIndex( [ 0, 1, 2, 3, 1, 2 ] );
        wing.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial( { color: 0x2b2620, side: THREE.DoubleSide } );
        const mesh = new THREE.InstancedMesh( wing, mat, count );
        this.scene.add( mesh );
        const birds = [];
        for ( let i = 0; i < count; i++ )
        {
            birds.push( {
                radius: fieldW * ( 0.25 + Math.random() * 0.5 ),
                height: 9 + Math.random() * 6,
                speed: 0.12 + Math.random() * 0.1,
                offset: Math.random() * Math.PI * 2,
                flapPhase: Math.random() * Math.PI * 2,
                z0: ( Math.random() - 0.5 ) * fieldD * 0.6
            } );
        }
        this._birds = { mesh, birds, count };
    };

    // ================================================================
    // ---------- Particle systems: fireflies / pollen / rain ----------
    // ================================================================
    Garden3D.prototype._buildFireflies = function ( fieldW, fieldD, count )
    {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array( count * 3 );
        const seeds = new Float32Array( count );
        for ( let i = 0; i < count; i++ )
        {
            const x = ( Math.random() - 0.5 ) * fieldW * 0.9;
            const z = ( Math.random() - 0.5 ) * fieldD * 0.9;
            positions[ i * 3 ] = x;
            positions[ i * 3 + 1 ] = 0.4 + Math.random() * 1.6;
            positions[ i * 3 + 2 ] = z;
            seeds[ i ] = Math.random() * 1000;
        }
        geo.setAttribute( "position", new THREE.BufferAttribute( positions, 3 ) );
        const tex = makeGlowTexture( "#fff6c9", "rgba(255,246,201,0)" );
        const mat = new THREE.PointsMaterial( {
            size: 0.22, map: tex, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, color: 0xffe9a3
        } );
        const points = new THREE.Points( geo, mat );
        this.scene.add( points );
        this._fireflies = { points, seeds, base: positions.slice() };
    };

    Garden3D.prototype._buildPollen = function ( fieldW, fieldD, count )
    {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array( count * 3 );
        const seeds = new Float32Array( count );
        for ( let i = 0; i < count; i++ )
        {
            positions[ i * 3 ] = ( Math.random() - 0.5 ) * fieldW;
            positions[ i * 3 + 1 ] = Math.random() * 5;
            positions[ i * 3 + 2 ] = ( Math.random() - 0.5 ) * fieldD;
            seeds[ i ] = Math.random() * 1000;
        }
        geo.setAttribute( "position", new THREE.BufferAttribute( positions, 3 ) );
        const tex = makeGlowTexture( "rgba(255,255,255,0.85)", "rgba(255,255,255,0)" );
        const mat = new THREE.PointsMaterial( {
            size: 0.06, map: tex, transparent: true, depthWrite: false, opacity: 0.5, color: 0xfff2d8
        } );
        const points = new THREE.Points( geo, mat );
        this.scene.add( points );
        this._pollen = { points, seeds, base: positions.slice(), fieldW, fieldD };
    };

    Garden3D.prototype._buildRain = function ( fieldW, fieldD, count )
    {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array( count * 3 );
        const speeds = new Float32Array( count );
        const topY = 16;
        for ( let i = 0; i < count; i++ )
        {
            positions[ i * 3 ] = ( Math.random() - 0.5 ) * fieldW * 1.05;
            positions[ i * 3 + 1 ] = Math.random() * topY;
            positions[ i * 3 + 2 ] = ( Math.random() - 0.5 ) * fieldD * 1.05;
            speeds[ i ] = 9 + Math.random() * 6;
        }
        geo.setAttribute( "position", new THREE.BufferAttribute( positions, 3 ) );
        const tex = makeGlowTexture( "rgba(200,220,255,0.9)", "rgba(200,220,255,0)" );
        const mat = new THREE.PointsMaterial( {
            size: 0.12, map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xbfd4ff
        } );
        const points = new THREE.Points( geo, mat );
        this.scene.add( points );
        this._rain = { points, speeds, fieldW, fieldD, topY };
    };

    // ================================================================
    // ---------- WeatherSystem ----------
    // ================================================================
    Garden3D.prototype._updateWeather = function ( dt )
    {
        const w = this._weather;
        this._nextWeatherChangeAt -= dt;
        if ( this._nextWeatherChangeAt <= 0 )
        {
            const roll = Math.random();
            const nextType = roll < 0.45 ? "clear" : ( roll < 0.8 ? "cloudy" : "rain" );
            if ( nextType !== w.type )
            {
                w.type = nextType;
                w.target = nextType === "clear" ? 0 : ( nextType === "cloudy" ? 0.45 : 1 );
                if ( this._onWeatherChange ) this._onWeatherChange( nextType );
            }
            this._nextWeatherChangeAt = 45 + Math.random() * 70;
        }
        w.intensity += ( w.target - w.intensity ) * Math.min( 1, dt * 0.25 );
        w.windStrength = 0.12 + w.intensity * 0.55;

        // أرض مبللة تدريجيًا
        if ( this._ground )
        {
            const wet = smoothstep( 0.5, 1.0, w.intensity );
            this._ground.material.color.copy( this._groundSeasonColors[ this._seasonIndex || 0 ] ).lerp( this._groundWetColor, wet );
            this._ground.material.roughness = 1 - wet * 0.55;
        }

        // كثافة السحاب بتزيد مع الطقس الغائم/الممطر
        if ( this._clouds ) this._clouds.forEach( c =>
        {
            c.sprite.material.opacity = c.baseOpacity * ( 0.6 + w.intensity * 1.1 );
        } );

        // المطر البصري
        if ( this._rain )
        {
            this._rain.points.material.opacity = smoothstep( 0.15, 0.6, w.intensity ) * 0.85;
        }

        // الرياح تتغذى للأشجار/العشب/الصوت
        if ( this._smallTreeMesh ) this._smallTreeMesh.windUniform.value = w.windStrength;
        if ( this._bigTreeMesh ) this._bigTreeMesh.windUniform.value = w.windStrength;
        if ( this._smallTreeMesh ) this._smallTreeMesh.seasonUniform.value = this._seasonIndex || 0;
        if ( this._bigTreeMesh ) this._bigTreeMesh.seasonUniform.value = this._seasonIndex || 0;
        if ( this._grass ) this._grass.windUniform.value = w.windStrength;
        if ( this._grass ) this._grass.seasonUniform.value = this._seasonIndex || 0;
        this.sound.setWindStrength( w.windStrength );
        this.sound.setRainIntensity( smoothstep( 0.2, 0.7, w.intensity ) );
    };

    // ================================================================
    // ---------- PostFX (Bloom اختياري) ----------
    // ================================================================
    Garden3D.prototype._buildPostFX = function ( width, height, settings )
    {
        const hasComposer = settings.bloom && THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass;
        if ( !hasComposer )
        {
            this._composer = null;
            return;
        }
        try
        {
            const composer = new THREE.EffectComposer( this.renderer );
            composer.addPass( new THREE.RenderPass( this.scene, this.camera ) );
            const bloom = new THREE.UnrealBloomPass( new THREE.Vector2( width, height ), 0.55, 0.6, 0.86 );
            composer.addPass( bloom );
            this._composer = composer;
            this._bloom = bloom;
        } catch ( e )
        {
            this._composer = null;
        }
    };

    // ================================================================
    // ---------- Interaction ----------
    // ================================================================
    Garden3D.prototype._setupInteraction = function ()
    {
        const self = this;
        const dom = this.renderer.domElement;
        dom.style.cursor = "grab";

        function pickIndex ( clientX, clientY )
        {
            const rect = dom.getBoundingClientRect();
            self._mouse.x = ( ( clientX - rect.left ) / rect.width ) * 2 - 1;
            self._mouse.y = -( ( clientY - rect.top ) / rect.height ) * 2 + 1;
            self._raycaster.setFromCamera( self._mouse, self.camera );
            const hit = self._raycaster.intersectObject( self._soil, false );
            if ( hit.length && hit[ 0 ].instanceId !== undefined ) return hit[ 0 ].instanceId;
            const hitTree = self._raycaster.intersectObjects( [ self._smallTreeMesh.mesh, self._bigTreeMesh.mesh ], false );
            if ( hitTree.length && hitTree[ 0 ].instanceId !== undefined )
            {
                return { treeIndex: hitTree[ 0 ].instanceId, treeType: hitTree[ 0 ].object === self._bigTreeMesh.mesh ? "big" : "small" };
            }
            return -1;
        }

        let downX = 0, downY = 0, moved = false;
        this._pointerDown = ( e ) => { downX = e.clientX; downY = e.clientY; moved = false; };
        this._pointerMove = ( e ) =>
        {
            if ( Math.abs( e.clientX - downX ) > 4 || Math.abs( e.clientY - downY ) > 4 ) moved = true;
            const res = pickIndex( e.clientX, e.clientY );
            self._setHover( typeof res === "number" ? res : -1 );
        };
        this._pointerLeave = () => self._setHover( -1 );
        this._pointerUp = ( e ) =>
        {
            if ( moved ) return;
            const res = pickIndex( e.clientX, e.clientY );
            if ( typeof res === "number" && res >= 0 )
            {
                if ( self._planted[ res ] )
                {
                    self.sound.select();
                    if ( self._onTreeClick ) self._onTreeClick( res, self._planted[ res ] );
                } else if ( self._onPlant )
                {
                    self._onPlant( res );
                }
            } else if ( res && res.treeIndex !== undefined )
            {
                self.sound.select();
                if ( self._onTreeClick ) self._onTreeClick( res.treeIndex, res.treeType );
            }
        };
        dom.addEventListener( "pointerdown", this._pointerDown, { passive: true } );
        dom.addEventListener( "pointermove", this._pointerMove, { passive: true } );
        dom.addEventListener( "pointerleave", this._pointerLeave, { passive: true } );
        dom.addEventListener( "pointerup", this._pointerUp, { passive: true } );
    };

    Garden3D.prototype.pause = function ()
    {
        if ( this._paused || this._disposed ) return;
        this._paused = true;
        if ( this._raf ) { cancelAnimationFrame( this._raf ); this._raf = null; }
        this.sound.pause();
    };

    Garden3D.prototype.resume = function ()
    {
        if ( !this._paused || this._disposed ) return;
        this._paused = false;
        this._clock.start();
        this.sound.resume();
        this._animate();
    };

    Garden3D.prototype._setHover = function ( index )
    {
        if ( index === this._hoverIndex ) return;
        const wasPlayable = this._hoverIndex >= 0 && !this._planted[ this._hoverIndex ] && this._plantable[ this._hoverIndex ];
        if ( wasPlayable ) this._soil.setColorAt( this._hoverIndex, this._colorPlantable );
        this._hoverIndex = index;
        if ( index >= 0 && !this._planted[ index ] )
        {
            const playable = !!this._plantable[ index ];
            this._soil.setColorAt( index, playable ? this._colorHover : this._colorEmpty );
            if ( playable ) this.sound.hover();
            this.renderer.domElement.style.cursor = playable ? "pointer" : "grab";
        } else
        {
            this.renderer.domElement.style.cursor = index >= 0 ? "pointer" : "grab";
        }
        if ( this._soil.instanceColor ) this._soil.instanceColor.needsUpdate = true;
    };

    // ================================================================
    // ---------- public state sync API (نفس التوقيعات القديمة) ----------
    // ================================================================
    Garden3D.prototype.setPlantableMask = function ( maskFn )
    {
        let changed = false;
        for ( let i = 0; i < this.cellCount; i++ )
        {
            if ( this._planted[ i ] ) continue;
            const val = maskFn( i ) ? 1 : 0;
            if ( this._plantable[ i ] !== val )
            {
                this._plantable[ i ] = val;
                this._soil.setColorAt( i, val ? this._colorPlantable : this._colorEmpty );
                changed = true;
            }
        }
        if ( changed && this._soil.instanceColor ) this._soil.instanceColor.needsUpdate = true;
    };

    Garden3D.prototype.applyState = function ( gardenArray )
    {
        for ( let i = 0; i < this.cellCount; i++ )
        {
            const v = gardenArray[ i ] || null;
            if ( v === this._planted[ i ] ) continue;
            this._planted[ i ] = v;
            if ( v ) this._placeTree( i, v, false ); else this._removeTree( i );
        }
    };

    Garden3D.prototype.plantAt = function ( index, type )
    {
        this._planted[ index ] = type;
        this._placeTree( index, type, true );
        this.sound.plant( type === "big" );
        this._soil.setColorAt( index, this._colorPlanted );
        if ( this._soil.instanceColor ) this._soil.instanceColor.needsUpdate = true;
    };

    Garden3D.prototype.shakeCell = function ( index )
    {
        this.sound.reject();
        this._shakeIndex = index;
        this._shakeT = 0;
    };

    Garden3D.prototype._placeTree = function ( index, type, animate )
    {
        const target = type === "big" ? this._bigTreeMesh : this._smallTreeMesh;
        const other = type === "big" ? this._smallTreeMesh : this._bigTreeMesh;
        this._hideInstance( other.mesh, index );
        const p = this._plotPos[ index ];
        const rot = ( index * 2.399963 ) % ( Math.PI * 2 );
        const jitter = 0.9 + ( ( index * 53 ) % 21 ) / 100;
        if ( animate )
        {
            this._growing = this._growing || [];
            this._growing.push( { mesh: target.mesh, index, pos: p, rot, jitter, t: 0 } );
        } else
        {
            const dummy = new THREE.Object3D();
            dummy.position.set( p.x, p.y, p.z );
            dummy.rotation.y = rot;
            dummy.scale.set( jitter, jitter, jitter );
            dummy.updateMatrix();
            target.mesh.setMatrixAt( index, dummy.matrix );
            target.mesh.instanceMatrix.needsUpdate = true;
        }
    };

    Garden3D.prototype._hideInstance = function ( mesh, index )
    {
        const dummy = new THREE.Object3D();
        dummy.scale.set( 0.0001, 0.0001, 0.0001 );
        dummy.updateMatrix();
        mesh.setMatrixAt( index, dummy.matrix );
        mesh.instanceMatrix.needsUpdate = true;
    };

    Garden3D.prototype._removeTree = function ( index )
    {
        this._hideInstance( this._smallTreeMesh.mesh, index );
        this._hideInstance( this._bigTreeMesh.mesh, index );
        this._soil.setColorAt( index, this._plantable[ index ] ? this._colorPlantable : this._colorEmpty );
        if ( this._soil.instanceColor ) this._soil.instanceColor.needsUpdate = true;
    };

    Garden3D.prototype.focusOnIndex = function ( index )
    {
        if ( !this.controls ) return;
        const p = this._plotPos[ index ];
        this._focusTarget = new THREE.Vector3( p.x, p.y + 1.1, p.z );
        this._focusCamPos = new THREE.Vector3( p.x + 3.2, p.y + 2.6, p.z + 3.6 );
        this._focusT = 0;
        this._focused = true;
        this.controls.autoRotate = false;
    };

    Garden3D.prototype.resetCamera = function ()
    {
        this._focused = false;
        this._unfocusT = 0;
        if ( this.controls ) this.controls.autoRotate = true;
    };

    Garden3D.prototype.onPlant = function ( cb ) { this._onPlant = cb; };
    Garden3D.prototype.onTreeClick = function ( cb ) { this._onTreeClick = cb; };
    // إضافات اختيارية غير مطلوبة من index.js الحالي، لكن متاحة لو حبيت تعرض
    // حالة الطقس أو الوقت في الـ HUD مستقبلًا بدون أي تعديل تاني في garden3d.js
    Garden3D.prototype.onWeatherChange = function ( cb ) { this._onWeatherChange = cb; };
    Garden3D.prototype.onTimeOfDay = function ( cb ) { this._onTimeOfDay = cb; };
    Garden3D.prototype.getWeather = function () { return this._weather.type; };
    Garden3D.prototype.isNight = function () { return !!this._isNightCached; };
    Garden3D.prototype.setSeason = function ( season )
    {
        const seasons = { spring: 0, summer: 1, autumn: 2, winter: 3 };
        if ( seasons[ season ] === undefined ) return false;
        this._season = season;
        this._seasonIndex = seasons[ season ];
        return true;
    };

    // ================================================================
    // ---------- animation loop ----------
    // ================================================================
    Garden3D.prototype._animate = function ()
    {
        if ( this._paused || this._disposed ) return;
        const self = this;
        this._raf = requestAnimationFrame( () => self._animate() );
        const dt = Math.min( this._clock.getDelta(), 0.05 );
        const t = this._clock.elapsedTime;

        // ---------- Dynamic Resolution: مراقبة الأداء وتعديل الدقة تلقائيًا ----------
        // بنعمل متوسط متحرك بسيط للـ FPS كل نص ثانية بدل الحكم على فريم واحد
        // (عشان ما نهزّش الدقة لأعلى وأسفل باستمرار)، ولو الأداء ضعيف بنقلل
        // pixelRatio تدريجيًا لحد الحد الأدنى، ولو رجع كويس بنرفعها تاني ببطء.
        this._fpsAccumTime = ( this._fpsAccumTime || 0 ) + dt;
        this._fpsAccumFrames = ( this._fpsAccumFrames || 0 ) + 1;
        if ( this._fpsAccumTime >= 0.5 )
        {
            const avgFps = this._fpsAccumFrames / this._fpsAccumTime;
            this._fpsAccumTime = 0; this._fpsAccumFrames = 0;
            if ( avgFps < 40 && this._pixelRatioCurrent > this._pixelRatioMin )
            {
                this._pixelRatioCurrent = Math.max( this._pixelRatioMin, this._pixelRatioCurrent - 0.15 );
                this._applyPixelRatio( this._pixelRatioCurrent );
            } else if ( avgFps > 55 && this._pixelRatioCurrent < this._pixelRatioMax )
            {
                this._pixelRatioCurrent = Math.min( this._pixelRatioMax, this._pixelRatioCurrent + 0.08 );
                this._applyPixelRatio( this._pixelRatioCurrent );
            }
        }

        this._updateDayNight( dt );
        this._updateWeather( dt );

        if ( this._smallTreeMesh.timeUniform ) this._smallTreeMesh.timeUniform.value = t;
        if ( this._bigTreeMesh.timeUniform ) this._bigTreeMesh.timeUniform.value = t;
        if ( this._grass )
        {
            this._grass.timeUniform.value = t;
            this._grass.windDirUniform.value = t * 0.05; // اتجاه الريح يتغير ببطء مع الوقت
        }
        if ( this._flowers ) this._flowers.timeUniform.value = t;

        // intro cinematic
        if ( this._introT < 1 )
        {
            this._introT = Math.min( 1, this._introT + dt / 2.4 );
            const e = 1 - Math.pow( 1 - this._introT, 3 );
            this.camera.position.lerpVectors( this._introFrom, this._defaultCamPos, e );
            if ( this.controls ) this.controls.update();
        } else if ( this._focused )
        {
            this._focusT = Math.min( 1, ( this._focusT || 0 ) + dt / 0.9 );
            const e = 1 - Math.pow( 1 - this._focusT, 3 );
            if ( this.controls )
            {
                this.controls.target.lerp( this._focusTarget, e * 0.25 );
                this.camera.position.lerp( this._focusCamPos, e * 0.06 );
                this.controls.update();
            }
        } else if ( this.controls )
        {
            this.controls.update();
        }

        // growth animation
        if ( this._growing && this._growing.length )
        {
            const dummy = new THREE.Object3D();
            this._growing = this._growing.filter( g =>
            {
                g.t = Math.min( 1, g.t + dt / 0.65 );
                const e = backOut( g.t );
                dummy.position.set( g.pos.x, g.pos.y, g.pos.z );
                dummy.rotation.y = g.rot;
                const s = g.jitter * e;
                dummy.scale.set( s, s, s );
                dummy.updateMatrix();
                g.mesh.setMatrixAt( g.index, dummy.matrix );
                g.mesh.instanceMatrix.needsUpdate = true;
                return g.t < 1;
            } );
        }

        // clouds drift
        if ( this._clouds ) this._clouds.forEach( c =>
        {
            c.sprite.position.x += c.speed * dt * ( 1 + this._weather.intensity );
            if ( c.sprite.position.x > this._cloudBoundX ) c.sprite.position.x = -this._cloudBoundX;
        } );

        // birds fly only during the day
        if ( this._birds )
        {
            const dummy = new THREE.Object3D();
            const visibleCount = this._dayFactor > 0.15 ? this._birds.count : 0;
            this._birds.mesh.count = visibleCount;
            if ( visibleCount )
            {
                this._birds.birds.forEach( ( b, i ) =>
                {
                    const ang = t * b.speed + b.offset;
                    const x = Math.cos( ang ) * b.radius;
                    const z = Math.sin( ang ) * b.radius * 0.6 + b.z0;
                    const y = b.height + Math.sin( t * 2 + b.flapPhase ) * 0.4;
                    dummy.position.set( x, y, z );
                    dummy.rotation.y = -ang - Math.PI / 2;
                    dummy.rotation.z = Math.sin( t * 9 + b.flapPhase ) * 0.35; // خفقان الجناح
                    const s = 0.6;
                    dummy.scale.set( s, s, s );
                    dummy.updateMatrix();
                    this._birds.mesh.setMatrixAt( i, dummy.matrix );
                } );
                this._birds.mesh.instanceMatrix.needsUpdate = true;
            }
        }

        // fireflies wander + twinkle — تبان بالليل بس
        if ( this._fireflies )
        {
            const geo = this._fireflies.points.geometry;
            const pos = geo.attributes.position;
            const seeds = this._fireflies.seeds;
            const base = this._fireflies.base;
            for ( let i = 0; i < seeds.length; i++ )
            {
                const s = seeds[ i ];
                pos.array[ i * 3 ] = base[ i * 3 ] + Math.sin( t * 0.5 + s ) * 1.4;
                pos.array[ i * 3 + 1 ] = base[ i * 3 + 1 ] + Math.sin( t * 0.9 + s * 1.3 ) * 0.4;
                pos.array[ i * 3 + 2 ] = base[ i * 3 + 2 ] + Math.cos( t * 0.4 + s ) * 1.4;
            }
            pos.needsUpdate = true;
            const twinkle = 0.5 + Math.sin( t * 2 ) * 0.2;
            this._fireflies.points.material.opacity = twinkle * this._nightFactor;
        }

        // pollen drift — نهارًا بس، وبيقل مع المطر
        if ( this._pollen )
        {
            const geo = this._pollen.points.geometry;
            const pos = geo.attributes.position;
            const seeds = this._pollen.seeds;
            const base = this._pollen.base;
            for ( let i = 0; i < seeds.length; i++ )
            {
                const s = seeds[ i ];
                pos.array[ i * 3 + 1 ] = ( ( base[ i * 3 + 1 ] + t * 0.15 + s ) % 5 );
                pos.array[ i * 3 ] = base[ i * 3 ] + Math.sin( t * 0.3 + s ) * 0.6;
            }
            pos.needsUpdate = true;
            this._pollen.points.material.opacity = 0.5 * this._dayFactor * ( 1 - this._weather.intensity * 0.8 );
        }

        // rain fall
        if ( this._rain && this._rain.points.material.opacity > 0.01 )
        {
            const geo = this._rain.points.geometry;
            const pos = geo.attributes.position;
            const speeds = this._rain.speeds;
            for ( let i = 0; i < speeds.length; i++ )
            {
                let y = pos.array[ i * 3 + 1 ] - speeds[ i ] * dt;
                if ( y < 0 )
                {
                    y = this._rain.topY;
                    pos.array[ i * 3 ] = ( Math.random() - 0.5 ) * this._rain.fieldW * 1.05;
                    pos.array[ i * 3 + 2 ] = ( Math.random() - 0.5 ) * this._rain.fieldD * 1.05;
                }
                pos.array[ i * 3 + 1 ] = y;
            }
            pos.needsUpdate = true;
        }

        if ( this._shootingStar )
        {
            const shot = this._shootingStar;
            if ( this._nightFactor > 0.65 && shot.progress < 0 ) shot.timer -= dt;
            if ( shot.timer <= 0 && shot.progress < 0 )
            {
                shot.progress = 0;
                shot.start.set( ( Math.random() - 0.5 ) * this._skyRadius, 10 + Math.random() * 12, -this._skyRadius * 0.7 );
                shot.end.copy( shot.start ).add( new THREE.Vector3( 5 + Math.random() * 6, -2 - Math.random() * 3, 0 ) );
            }
            if ( shot.progress >= 0 )
            {
                shot.progress += dt * 1.8;
                const head = shot.start.clone().lerp( shot.end, Math.min( 1, shot.progress ) );
                const tail = shot.start.clone().lerp( head, Math.max( 0, shot.progress - 0.28 ) );
                shot.line.geometry.attributes.position.array.set( [ head.x, head.y, head.z, tail.x, tail.y, tail.z ] );
                shot.line.geometry.attributes.position.needsUpdate = true;
                shot.line.material.opacity = Math.max( 0, 1 - shot.progress ) * 0.95;
                if ( shot.progress >= 1 ) { shot.progress = -1; shot.timer = 9 + Math.random() * 18; shot.line.material.opacity = 0; }
            }
        }

        // thunder flash: ومضة إضاءة قصيرة
        if ( this._thunderFlashT !== undefined && this._thunderFlashT !== null )
        {
            this._thunderFlashT += dt;
            const flash = Math.max( 0, 1 - this._thunderFlashT / 0.35 );
            this._hemi.intensity += flash * 1.6;
            this._fillLight.intensity += flash * 1.2;
            if ( this._thunderFlashT > 0.35 ) this._thunderFlashT = null;
        }

        this.renderer.render( this.scene, this.camera );
        if ( this._composer )
        {
            try { this._composer.render(); } catch ( e ) { this._composer = null; this.renderer.render( this.scene, this.camera ); }
        }
    };

    // نداء عام (بدون underscore) عشان الكود بره الملف (index.js) يقدر يجبر
    // إعادة ضبط حجم الرندرر بعد تغييرات زي فتح/قفل ملء الشاشة.
    Garden3D.prototype.resize = function () { this._onResize(); };

    // بيطبّق pixelRatio جديد على الرندرر وعلى الـ composer (لو موجود) مع
    // بعض — بعض نسخ EffectComposer القديمة اللي بتيجي من الـ CDN معندهاش
    // setPixelRatio مباشرة، فبنعمل fallback بإعادة setSize بالحجم الحالي.
    Garden3D.prototype._applyPixelRatio = function ( ratio )
    {
        this.renderer.setPixelRatio( ratio );
        if ( this._composer )
        {
            try
            {
                if ( typeof this._composer.setPixelRatio === "function" ) this._composer.setPixelRatio( ratio );
                else this._onResize();
            }
            catch ( e ) { /* تجاهل — الرندرر الأساسي كفاية لو الـ composer رفض */ }
        }
    };

    Garden3D.prototype._onResize = function ()
    {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        if ( !w || !h ) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize( w, h );
        if ( this._composer ) this._composer.setSize( w, h );
    };

    Garden3D.prototype.dispose = function ()
    {
        if ( this._disposed ) return;
        this._disposed = true;
        if ( this._raf ) cancelAnimationFrame( this._raf );
        if ( this._resizeObs ) this._resizeObs.disconnect();
        if ( this.renderer && this._pointerDown )
        {
            const dom = this.renderer.domElement;
            dom.removeEventListener( "pointerdown", this._pointerDown );
            dom.removeEventListener( "pointermove", this._pointerMove );
            dom.removeEventListener( "pointerleave", this._pointerLeave );
            dom.removeEventListener( "pointerup", this._pointerUp );
        }
        if ( this.controls ) this.controls.dispose();
        if ( this._composer )
        {
            if ( this._composer.passes ) this._composer.passes.forEach( pass => { if ( pass.dispose ) pass.dispose(); } );
            if ( this._composer.renderTarget1 ) this._composer.renderTarget1.dispose();
            if ( this._composer.renderTarget2 ) this._composer.renderTarget2.dispose();
        }
        if ( this.scene ) this.scene.traverse( object =>
        {
            if ( object.geometry ) object.geometry.dispose();
            if ( object.material )
            {
                const materials = Array.isArray( object.material ) ? object.material : [ object.material ];
                materials.forEach( material =>
                {
                    [ "map", "alphaMap", "emissiveMap", "normalMap" ].forEach( key => { if ( material[ key ] ) material[ key ].dispose(); } );
                    material.dispose();
                } );
            }
        } );
        this.sound.dispose();
        if ( this.renderer )
        {
            this.renderer.renderLists.dispose();
            this.renderer.dispose();
            if ( this.renderer.domElement.parentNode ) this.renderer.domElement.parentNode.removeChild( this.renderer.domElement );
        }
        this.scene = null; this.renderer = null; this.controls = null;
    };

    global.Garden3D = Garden3D;

} )( window );