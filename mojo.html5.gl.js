(function(){

	document.addEventListener("DOMContentLoaded", function() { init("GameCanvas"); }, false);

	var M_PI = 3.1415926535897932384626433832795028841968;
	var M_TWO_PI = 2.0 * M_PI;
	var M_HALF_PI = M_PI / 2.0;

	var WebGL2D = this.WebGL2D = function WebGL2D(canvas) {
		this.canvas = canvas;
		this.gl = undefined;
		this.fs = undefined;
		this.vs = undefined;
		this.shaderProgram = undefined;
		this.shaderPool = [];
		this.maxTextureSize = undefined;
		this.width;
		this.height;

		canvas.gl2d = this;

		var gl = this.gl = canvas.getContext("webgl", {alpha: false}) || canvas.getContext("experimental-webgl", {alpha: false});

		if ((typeof(gl) === "undefined") || (gl === null)) return;

		try {
			this.initShaders();
		} catch (e) { throw e; }

		canvas.getContext = (function(gl2d) {
			return function(context) {
				return new WebGL2DAPI(gl2d);
			};
		}(this));
	};

	var shaderMask = {
		texture: 1,
		crop: 2
	};

	WebGL2D.prototype.getFragmentShaderSource = function getFragmentShaderSource(sMask) {
		var fsSource = [];

		fsSource.push(
			"precision mediump float;",
			"varying vec4 vColor;"
		);

		if (sMask&shaderMask.texture) {
			fsSource.push(
				"varying vec2 vTextureCoord;",
				"uniform sampler2D uSampler;"
			);

			if (sMask&shaderMask.crop) {
				fsSource.push("uniform vec4 uCropSource;");
			}
		}

		fsSource.push("void main(void) {");

		if (sMask&shaderMask.texture) {
			if (sMask&shaderMask.crop) {
				fsSource.push("gl_FragColor = texture2D(uSampler, vec2(vTextureCoord.x * uCropSource.z, vTextureCoord.y * uCropSource.w) + uCropSource.xy) * vColor;");
			} else {
				fsSource.push("gl_FragColor = texture2D(uSampler, vTextureCoord) * vColor;");
			}
		} else {
			fsSource.push("gl_FragColor = vColor;");
		}

		fsSource.push("}");

		return fsSource.join("\n");
	};

	WebGL2D.prototype.getVertexShaderSource = function getVertexShaderSource(sMask) {
		var w = 2 / this.canvas.width, h = -2 / this.canvas.height;

		var vsSource = [];

		vsSource.push(
			"attribute vec4 aVertexPosition;",
			"uniform vec4 uColor;",
			"varying vec4 vColor;",
			"const mat4 pMatrix = mat4(" + w + ",0,0,0, 0," + h + ",0,0, 0,0,1.0,1.0, -1.0,1.0,0,0);"
		);

		if (sMask&shaderMask.texture) {
			vsSource.push("varying vec2 vTextureCoord;");
		}

		vsSource.push(
			"void main(void) {",
			"vec3 position = vec3(aVertexPosition.x, aVertexPosition.y, 1.0);",
			"gl_Position = pMatrix * vec4(position, 1.0);",
			"vColor = uColor;"
		);

		if (sMask&shaderMask.texture) {
			vsSource.push("vTextureCoord = aVertexPosition.zw;");
		}

		vsSource.push("}");

		return vsSource.join("\n");
	};

	WebGL2D.prototype.initShaders = function initShaders(sMask) {
		var gl = this.gl;

		sMask = sMask || 0;
		var storedShader = this.shaderPool;

		if (!storedShader) { storedShader = this.shaderPool = []; }
		storedShader = storedShader[sMask];

		if (storedShader) {
			gl.useProgram(storedShader);
			this.shaderProgram = storedShader;
			return storedShader;
		} else {
			var fs = this.fs = gl.createShader(gl.FRAGMENT_SHADER);
			gl.shaderSource(this.fs, this.getFragmentShaderSource(sMask));
			gl.compileShader(this.fs);

			if (!gl.getShaderParameter(this.fs, gl.COMPILE_STATUS)) {
				throw "fragment shader error: "+gl.getShaderInfoLog(this.fs);
			}

			var vs = this.vs = gl.createShader(gl.VERTEX_SHADER);
			gl.shaderSource(this.vs, this.getVertexShaderSource(sMask));
			gl.compileShader(this.vs);

			if (!gl.getShaderParameter(this.vs, gl.COMPILE_STATUS)) {
				throw "vertex shader error: "+gl.getShaderInfoLog(this.vs);
			}

			var shaderProgram = this.shaderProgram = gl.createProgram();
			gl.attachShader(shaderProgram, fs);
			gl.attachShader(shaderProgram, vs);
			gl.linkProgram(shaderProgram);

			if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
				throw "Could not initialise shaders.";
			}

			gl.useProgram(shaderProgram);

			shaderProgram.vertexPositionAttribute = gl.getAttribLocation(shaderProgram, "aVertexPosition");
			gl.enableVertexAttribArray(shaderProgram.vertexPositionAttribute);

			shaderProgram.uColor = gl.getUniformLocation(shaderProgram, 'uColor');
			shaderProgram.uSampler = gl.getUniformLocation(shaderProgram, 'uSampler');
			shaderProgram.uCropSource = gl.getUniformLocation(shaderProgram, 'uCropSource');

			this.shaderPool[sMask] = shaderProgram;
			return shaderProgram;
		}
	};	

	var WebGL2DAPI = this.WebGL2DAPI = function WebGL2DAPI(gl2d) {
		var gl = gl2d.gl;

		gl2d.width = -1;
		gl2d.height = -1;
		gl2d.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		if (!isPOT(gl2d.maxTextureSize)) gl2d.maxTextureSize += 1;

		var MAX_VERTICES = parseInt(65536 / 20);
		var MAX_RENDERS = parseInt(MAX_VERTICES / 2);

		var red = 1.0, green = 1.0, blue = 1.0;
		var alpha = 1.0, blend = 0;		

		var MODE_NONE = 0, MODE_TEXTURED = 1, MODE_CROPPED = 2;
		var mode = MODE_NONE;
		var gxtk;

		var imageCache = [], textureCache = [];

		var buffer = {
			vdata: new Float32Array(new Array(MAX_VERTICES * 4)),
			vcount: 0,
			vpointer: 0,
			pointer: gl.createBuffer()
		};

		var render = {
			last: {type: -1, count: 0},
			next: 0
		}

		var rendersPool = new Array(MAX_RENDERS);

		for (var i = 0; i < rendersPool.length; i++) {
			rendersPool[i] = {
				type: -1,
				count: 0,
				texture: null,
				srcx: 0, srcy: 0, srcw: 0, srch: 0
			}
		}

		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		gl.bindBuffer(gl.ARRAY_BUFFER, buffer.pointer);	

		//mojo runtime patching
		gxtkGraphics.prototype.BeginRender = function() {
			if (this.gc) {
				if (gl2d.width !== this.Width() || gl2d.height !== this.Height()) {
					gl2d.shaderPool = [];
					gl2d.initShaders();

					gl2d.width = this.Width();
					gl2d.height = this.Height();
					gl.viewport(0, 0, gl2d.width, gl2d.height);
				}
			
				gxtk = this;	
			}
		}

		gxtkGraphics.prototype.EndRender = function(){
			renderPull();
		}

		gxtkGraphics.prototype.LoadSurface = function( path ){
			var app = this.app;
			
			function onloadfun(){
				app.DecLoading();

				if (!this.texture) {
					var cacheIndex = imageCache.indexOf(image);

					if (cacheIndex !== -1) {
						this.texture = textureCache[cacheIndex];
					} else {
						this.texture = new Texture(image);
					}
				}				
			}

			app.IncLoading();

			var image = loadImage( path, onloadfun);
			if (image) return new gxtkSurface( image,this );

			app.DecLoading();

			return null;
		}

		gxtkGraphics.prototype.SetAlpha = function(a){
			if (alpha === a) return;
			renderPull();
			alpha = a;
		}

		gxtkGraphics.prototype.SetColor = function(r, g, b){
			if (red === r && green === g && blue === b) return;
			renderPull();
			red = r; green = g; blue = b;
		}

		gxtkGraphics.prototype.SetBlend = function(b){
			if (blend === b) return;
			renderPull();			

			switch (b) {
				case 1:
					gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
					break;
				default:
					gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			}

			blend = b;
		}

		gxtkGraphics.prototype.SetScissor = function(x,y,w,h) {
			renderPull();

			if (x !== 0 || y !== 0 || w !== this.Width() || h !== this.Height()) {
				gl.enable(gl.SCISSOR_TEST);
				y = this.Height() - y - h;
				gl.scissor(x, y, w, h);
			} else {
				gl.disable(gl.SCISSOR_TEST);
			}
		}

		gxtkGraphics.prototype.SetMatrix = function(ix, iy, jx, jy, tx, ty) {
			this.ix = ix; this.iy = iy;
			this.jx = jx; this.jy = jy;
			this.tx = tx; this.ty = ty;
			this.tformed = (ix !== 1 || iy !== 0 || jx !== 0 || jy !== 1 || tx !== 0 || ty !== 0);
		}

		gxtkGraphics.prototype.Cls = function(r, g, b) {
			gl.clearColor(r / 255, g / 255, b / 255, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}

		gxtkGraphics.prototype.DrawPoint = function(x, y){
			if (mode !== MODE_NONE) renderPull();

			renderPush(gl.POINTS, 1);

			if (this.tformed) {
				var px = x;
				x = px * this.ix + y * this.jx + this.tx;
				y = px * this.iy + y * this.jy + this.ty;
			}
			
			buffer.vdata[buffer.vpointer] = x;
			buffer.vdata[buffer.vpointer + 1] = y;

			mode = MODE_NONE;
		}		

		gxtkGraphics.prototype.DrawRect = function(x, y, w, h){
			if (mode !== MODE_NONE) renderPull();

			renderPushRect(x, y, w, h);

			mode = MODE_NONE;
		}

		gxtkGraphics.prototype.DrawLine = function(x1, y1, x2, y2) {
			if (mode !== MODE_NONE) renderPull();

			renderPush(gl.LINES, 2);

			if (this.tformed) {
				var tx0 = x0, tx1 = x1;
				x1 = tx0 * this.ix + y1 * this.jx + this.tx;
				y1 = tx0 * this.iy + y1 * this.jy + this.ty;
				x2 = tx1 * this.ix + y2 * this.jx + this.tx;
				y2 = tx1 * this.iy + y2 * this.jy + this.ty;
			}

			buffer.vdata[buffer.vpointer] = x1; 
			buffer.vdata[buffer.vpointer + 1] = y1;
			buffer.vdata[buffer.vpointer + 2] = 0; 
			buffer.vdata[buffer.vpointer + 3] = 0; 
			buffer.vdata[buffer.vpointer + 4] = x2; 
			buffer.vdata[buffer.vpointer + 5] = y2; 
			buffer.vdata[buffer.vpointer + 6] = 0; 
			buffer.vdata[buffer.vpointer + 7] = 0;

			mode = MODE_NONE;
		}

		gxtkGraphics.prototype.DrawOval = function(x, y, w, h) {
			if (mode !== MODE_NONE) renderPull();

			var xr = w / 2.0;
			var yr = h / 2.0;

			var segs;

			if (this.tformed) {
				var xx = xr * this.ix, xy = xr * this.iy, xd = parseFloat(Math.sqrt(xx * xx + xy * xy));
				var yx = yr * this.jx, yy = yr * this.jy, yd = parseFloat(Math.sqrt(yx * yx + yy * yy));

				segs= parseInt(xd + yd);
			}else{
				segs = parseInt(Math.abs(xr) + Math.abs(yr));
			}
			

			if (segs > MAX_VERTICES) {
				segs = MAX_VERTICES;
			} else if (segs < 12) {
				segs=12;
			} else {
				segs &=~ 3;
			}
		
			x += xr;
			y += yr;

			renderPush(gl.TRIANGLE_FAN, segs);

			for (var i=0; i < segs; i++) {
				var th = i * 6.28318531 / segs;
				var x0 = (x + Math.cos(th) * xr);
				var y0 = (y + Math.sin(th) * yr);

				if (this.tformed){
					var tx0 = x0;

					x0 = tx0 * this.ix + y0 * jx + this.tx;
					y0 = tx0 * this.iy + y0 * jy + this.ty;
				}

				buffer.vdata[buffer.vpointer] = x0;
				buffer.vdata[buffer.vpointer + 1] = y0;
				buffer.vpointer += 4;
			}

			mode = MODE_NONE;
		}	

		gxtkGraphics.prototype.DrawPoly = function(verts) {
			if (mode !== MODE_NONE) renderPull();

			if (verts.length < 6 || verts.length > MAX_VERTICES * 2) return;
	
			renderPush(gl.TRIANGLE_FAN, verts.length / 2);

			if (this.tformed) {
				for (var i = 0; i < verts.length; i += 2) {
					buffer.vdata[buffer.vpointer] = verts[i] * this.ix + verts[i + 1] * this.jx + this.tx;
					buffer.vdata[buffer.vpointer + 1] = verts[i] * this.iy + verts[i + 1] * this.jy + this.ty;
					buffer.vpointer += 4;
				}
			} else {			
				for (var i = 0; i < verts.length; i += 2) {
					buffer.vdata[buffer.vpointer] = verts[i];
					buffer.vdata[buffer.vpointer + 1] = verts[i + 1];
					buffer.vpointer += 4;
				}
			}

			mode = MODE_NONE;
		}

		gxtkGraphics.prototype.DrawSurface = function(surface, x, y) {
			if (!surface.image.complete) return;
			if (mode !== MODE_TEXTURED) renderPull();

			if (!surface.image.texture) {
				var cacheIndex = imageCache.indexOf(surface.image);

				if (cacheIndex !== -1) {
					surface.image.texture = textureCache[cacheIndex];
				} else {
					surface.image.texture = new Texture(surface.image);
				}
			}

			renderPushRect(x, y, surface.swidth, surface.sheight);
			render.last.texture = surface.image.texture;

			mode = MODE_TEXTURED;
		}

		gxtkGraphics.prototype.DrawSurface2 = function(surface, x, y, srcx, srcy, srcw, srch) {
			if (!surface.image.complete) return;
			if (mode !== MODE_CROPPED) renderPull();

			if (!surface.image.texture) {
				var cacheIndex = imageCache.indexOf(surface.image);

				if (cacheIndex !== -1) {
					surface.image.texture = textureCache[cacheIndex];
				} else {
					surface.image.texture = new Texture(surface.image);
				}
			}

			renderPushRect(x, y, srcw, srch);
			render.last.srcx = srcx; render.last.srcy = srcy;
			render.last.srcw = srcw; render.last.srch = srch;
			render.last.texture = surface.image.texture;

			mode = MODE_CROPPED;
		}

		function renderPush(type, count) {
			if (buffer.vcount + count > MAX_VERTICES || render.next === MAX_RENDERS) {
				renderPull();
			}

			render.last = rendersPool[render.next];
			render.next += 1;

			render.last.type = type;
			render.last.count = count;
			render.last.texture = null;

			buffer.vpointer = buffer.vcount * 4;
			buffer.vcount += count;
		}

		function renderPull() {
			if (buffer.vcount === 0) return;

			var shaderProgram = gl2d.shaderProgram;
			var cTexture = null;
			var index = 0;
			var r;

			gl.bufferData(gl.ARRAY_BUFFER, buffer.vdata, gl.DYNAMIC_DRAW);

			switch (mode) {
				case MODE_NONE:
					shaderProgram = gl2d.initShaders(0);

					gl.vertexAttribPointer(shaderProgram.vertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);
					gl.uniform4f(shaderProgram.uColor, red / 255, green / 255, blue / 255, alpha);

					for (var i = 0; i < render.next; i++) {
						r = rendersPool[i];

						gl.drawArrays(r.type, index, r.count);

						index += r.count;
					}
					break;

				case MODE_TEXTURED:
					shaderProgram = gl2d.initShaders(shaderMask.texture);

					gl.vertexAttribPointer(shaderProgram.vertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);
					gl.uniform4f(shaderProgram.uColor, red / 255, green / 255, blue / 255, alpha);

					for (var i = 0; i < render.next; i++) {
						r = rendersPool[i];

						if (cTexture !== r.texture) {
							gl.bindTexture(gl.TEXTURE_2D, r.texture.obj);
							gl.activeTexture(gl.TEXTURE0);
							gl.uniform1i(shaderProgram.uSampler, 0);

							cTexture = r.texture;
						}

						gl.drawArrays(r.type, index, r.count);

						index += r.count;
					}
					break;

				case MODE_CROPPED:
					shaderProgram = gl2d.initShaders(shaderMask.texture|shaderMask.crop);

					gl.vertexAttribPointer(shaderProgram.vertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);
					gl.uniform4f(shaderProgram.uColor, red / 255, green / 255, blue / 255, alpha);

					for (var i = 0; i < render.next; i++) {
						r = rendersPool[i];

						if (cTexture !== r.texture) {
							gl.bindTexture(gl.TEXTURE_2D, r.texture.obj);
							gl.activeTexture(gl.TEXTURE0);
							gl.uniform1i(shaderProgram.uSampler, 0);

							cTexture = r.texture;
						}

						gl.uniform4f(shaderProgram.uCropSource, r.srcx / r.texture.width, 
								r.srcy / r.texture.height, r.srcw / r.texture.width, r.srch / r.texture.height);

						gl.drawArrays(r.type, index, r.count);

						index += r.count;
					}
					break;
			}

			renderReset();
		}

		function renderReset() {
			buffer.vcount = 0;
			render.next = 0;
			mode = MODE_NONE;
		}

		function renderPushRect(x, y, w, h) {
			renderPush(gl.TRIANGLE_FAN, 4);

			var x0 = x, x1 = x + w, x2 = x + w, x3 = x;
			var y0 = y, y1 = y, y2 = y+h, y3 = y + h;
			
			if (gxtk.tformed) {
				var tx0 = x0,tx1 = x1,tx2 = x2,tx3 = x3;
				
				x0 = tx0 * gxtk.ix + y0 * gxtk.jx + gxtk.tx;
				y0 = tx0 * gxtk.iy + y0 * gxtk.jy + gxtk.ty;
				x1 = tx1 * gxtk.ix + y1 * gxtk.jx + gxtk.tx;
				y1 = tx1 * gxtk.iy + y1 * gxtk.jy + gxtk.ty;
				x2 = tx2 * gxtk.ix + y2 * gxtk.jx + gxtk.tx;
				y2 = tx2 * gxtk.iy + y2 * gxtk.jy + gxtk.ty;
				x3 = tx3 * gxtk.ix + y3 * gxtk.jx + gxtk.tx;
				y3 = tx3 * gxtk.iy + y3 * gxtk.jy + gxtk.ty;
			}
		
			buffer.vdata[buffer.vpointer] = x0; 
			buffer.vdata[buffer.vpointer + 1] = y0; 
			buffer.vdata[buffer.vpointer + 2] = 0; 
			buffer.vdata[buffer.vpointer + 3] = 0;
			buffer.vdata[buffer.vpointer + 4] = x1; 
			buffer.vdata[buffer.vpointer + 5] = y1; 
			buffer.vdata[buffer.vpointer + 6] = 1; 
			buffer.vdata[buffer.vpointer + 7] = 0;
			buffer.vdata[buffer.vpointer + 8] = x2;
			buffer.vdata[buffer.vpointer + 9] = y2; 
			buffer.vdata[buffer.vpointer + 10] = 1; 
			buffer.vdata[buffer.vpointer + 11] = 1;
			buffer.vdata[buffer.vpointer + 12] = x3; 
			buffer.vdata[buffer.vpointer + 13] = y3; 
			buffer.vdata[buffer.vpointer + 14] = 0; 
			buffer.vdata[buffer.vpointer + 15] = 1;
		}		

		function Texture(image) {
			this.obj = gl.createTexture();
			this.index = textureCache.push(this);
			imageCache.push(image);

			this.width = image.meta_width;
			this.height = image.meta_height;

			var mojoFilteringEnabled = (typeof(CFG_MOJO_IMAGE_FILTERING_ENABLED) === "undefined" || CFG_MOJO_IMAGE_FILTERING_ENABLED === "true");

			if (image.width > gl2d.maxTextureSize || image.height > gl2d.maxTextureSize) {
				var canvas = document.createElement("canvas");

				canvas.width  = (image.width  > gl2d.maxTextureSize) ? gl2d.maxTextureSize : image.width;
				canvas.height = (image.height > gl2d.maxTextureSize) ? gl2d.maxTextureSize : image.height;

				var ctx = canvas.getContext("2d");

				ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);

				image = canvas;
			}

			gl.bindTexture(gl.TEXTURE_2D, this.obj);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

			if (mojoFilteringEnabled) {
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			} else {
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			}

			if (isPOT(image.width) && isPOT(image.height)) {
				if (mojoFilteringEnabled) {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
					gl.generateMipmap(gl.TEXTURE_2D);
				} else {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
					gl.generateMipmap(gl.TEXTURE_2D);
				}
			} else {
				if (mojoFilteringEnabled) {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				} else {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
				}
			}
		}

		function isPOT(value) {
			return value > 0 && ((value - 1) & value) === 0;
		}			
	}	

	function init(id) {
		var chromeFrameEnabled = false;
		
		if (typeof window.ActiveXObject != "undefined") try {
			var activeX = new ActiveXObject("ChromeTab.ChromeFrame");
			if (activeX) {
				try {
					var tryChromeFrame = document.createElement("canvas");
					var gl = tryChromeFrame.getContext("webgl") || tryChromeFrame.getContext("experimental-webgl");				
					chromeFrameEnabled = (typeof(gl) !== 'undefined' && gl !== null);
				} catch (e) {}
			}
		} catch (e) {}		
	
		if (navigator.userAgent.indexOf("MSIE") < 0 || chromeFrameEnabled) {
			if (!chromeFrameEnabled && navigator.userAgent.indexOf("Opera") >= 0) try {
				new WebGL2D(document.createElement("canvas"));
			} catch  (e) { return; }

			new WebGL2D(document.getElementById(id));
		} else {
			var tryIEWebGL = document.createElement("object");
			
			tryIEWebGL.onreadystatechange = function() {
				var canvas = document.getElementById(id);
				var IEWebGL = document.createElement("object");
				
				IEWebGL.onreadystatechange = function() {
					new WebGL2D(IEWebGL);
				}
				
				canvas.parentNode.replaceChild(IEWebGL, canvas);
				
				IEWebGL.id = id;				
				IEWebGL.width = canvas.width;
				IEWebGL.height = canvas.height;	
				IEWebGL.type = "application/x-webgl";
			};
			
			tryIEWebGL.type = "application/x-webgl";
		}
	}

})();