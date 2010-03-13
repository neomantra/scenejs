/**
 * This backend encapsulates shading behind an event API.
 *
 * By listening to XXX_UPDATED events, this backend tracks various elements of scene state, such as WebGL settings,
 * lighting, current material properties etc.
 *
 * On a SHADER_ACTIVATE event it will compose and activate a shader taylored to the current scene state
 * (ie. where the shader has variables and routines for the current lights, materials etc), then fire a
 * SHADER_ACTIVATED event when the shader is ready for business.
 *
 * Other backends will then handle the SHADER_ACTIVATED event by firing XXXXX_EXPORTED events parameterised with
 * resources that they want loaded into the shader. This backend then handles those by loading their parameters into
 * the shader.
 *
 * The backend will avoid constant re-generation of shaders by caching each of them against a hash code that it
 * derives from the current collective scene state; on a SHADER_ACTIVATE event, it will attempt to reuse a shader
 * cached for the hash of the current scene state.
 *
 * Shader allocation and LRU cache eviction is mediated by the "memory" backend.
 */
SceneJS._backends.installBackend(

        "shader",

        function(ctx) {

            var time = (new Date()).getTime();      // For LRU caching
            var canvas;                             // Currently active canvas
            var rendererState;                      // WebGL settings state
            var programs = {};                      // Program cache
            var activeProgram = null;               // Currently active program
            var lights = [];                        // Current lighting state
            var material = {};                      // Current material state
            var fog = null;                         // Current fog
            var texture = false;                    // True when a texture is active
            var sceneHash;                          // Current hash of collective scene state pertenant to shaders

            ctx.events.onEvent(
                    SceneJS._eventTypes.TIME_UPDATED,
                    function(t) {
                        time = t;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.RESET,
                    function() {
                        for (var programId in programs) {  // Just free allocated programs
                            programs[programId].destroy();
                        }
                        programs = {};
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.SCENE_ACTIVATED,
                    function() {
                        canvas = null;
                        rendererState = null;
                        activeProgram = null;
                        lights = [];
                        material = {};
                        texture = false;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.CANVAS_ACTIVATED,
                    function(c) {
                        canvas = c;
                        activeProgram = null;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.CANVAS_DEACTIVATED,
                    function() {
                        canvas = null;
                        activeProgram = null;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.RENDERER_UPDATED,
                    function(_rendererState) {
                        rendererState = _rendererState;  // Canvas change will be signified by a CANVAS_UPDATED
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.RENDERER_EXPORTED,
                    function(_rendererState) {

                        /* Default ambient material colour is taken from canvas clear colour
                         */
                        var clearColor = _rendererState.clearColor;
                        activeProgram.setUniform("uAmbient",
                                clearColor
                                        ? [clearColor.r, clearColor.g, clearColor.b]
                                        : [0, 0, 0]);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.TEXTURE_ACTIVATED,
                    function(t) {
                        texture = t;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.TEXTURE_EXPORTED,
                    function(texture) {
                        activeProgram.bindTexture("uSampler", texture);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.TEXTURE_DEACTIVATED,
                    function() {
                        texture = null;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.LIGHTS_UPDATED,
                    function(l) {
                        lights = l;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.LIGHTS_EXPORTED,
                    function(_lights) {
                        for (var i = 0; i < _lights.length; i++) {
                            var light = _lights[i];

                            activeProgram.setUniform("uLightAmbient" + i, light.ambient);
                            activeProgram.setUniform("uLightDiffuse" + i, light.diffuse);
                            activeProgram.setUniform("uLightSpecular" + i, light.specular);

                            activeProgram.setUniform("uLightPos" + i, light.pos);
                            activeProgram.setUniform("uLightSpotDir" + i, light.spotDir);

                            if (light.type == "spot") {
                                activeProgram.setUniform("uLightSpotCosCutOff" + i, light.spotCosCutOff);
                                activeProgram.setUniform("uLightSpotExp" + i, light.spotExponent);
                            }

                            activeProgram.setUniform("uLightAttenuation" + i,
                                    [
                                        light.constantAttenuation,
                                        light.linearAttenuation,
                                        light.quadraticAttenuation
                                    ]);
                        }
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.MATERIAL_UPDATED,
                    function(m) {
                        material = m;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.MATERIAL_EXPORTED,
                    function(m) {
                        activeProgram.setUniform("uMaterialAmbient", m.ambient);
                        activeProgram.setUniform("uMaterialDiffuse", m.diffuse);
                        activeProgram.setUniform("uMaterialSpecular", m.specular);
                        activeProgram.setUniform("uMaterialShininess", m.shininess);
                        activeProgram.setUniform("uMaterialEmission", m.emission);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.FOG_UPDATED,
                    function(f) {
                        fog = f;
                        sceneHash = null;
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.FOG_EXPORTED,
                    function(f) {
                        activeProgram.setUniform("uFogColor", f.color);
                        activeProgram.setUniform("uFogDensity", f.density);
                        activeProgram.setUniform("uFogStart", f.start);
                        activeProgram.setUniform("uFogEnd", f.end);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.MODEL_TRANSFORM_EXPORTED,
                    function(transform) {
                        activeProgram.setUniform("uMMatrix", transform.matrixAsArray);
                        activeProgram.setUniform("uMNMatrix", transform.normalMatrixAsArray);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.VIEW_TRANSFORM_EXPORTED,
                    function(transform) {
                        activeProgram.setUniform("uVMatrix", transform.matrixAsArray);
                        activeProgram.setUniform("uVNMatrix", transform.normalMatrixAsArray);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.PROJECTION_TRANSFORM_EXPORTED,
                    function(transform) {
                        activeProgram.setUniform("uPMatrix", transform.matrixAsArray);
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.GEOMETRY_EXPORTED,
                    function(geo) {
                        activeProgram.bindFloatArrayBuffer("aVertex", geo.vertexBuf);
                        activeProgram.bindFloatArrayBuffer("aNormal", geo.normalBuf);
                        if (geo.texCoordBuf && texture && rendererState.enableTexture2D) {
                            activeProgram.bindFloatArrayBuffer("aTextureCoord", geo.texCoordBuf);
                        }
                    });

            ctx.events.onEvent(
                    SceneJS._eventTypes.SHADER_ACTIVATE, // Request to activate a shader
                    function() {
                        activateProgram();
                    });

            ctx.memory.registerEvictor(
                    function() {
                        var earliest = time;
                        var programToEvict;
                        for (var hash in programs) {
                            if (hash) {
                                var program = programs[hash];

                                /* Avoiding eviction of shader just used,
                                 * currently in use, or likely about to use
                                 */
                                if (program.lastUsed < earliest && program.hash != sceneHash) {
                                    programToEvict = program;
                                    earliest = programToEvict.lastUsed;
                                }
                            }
                        }
                        if (programToEvict) { // Delete LRU program's shaders and deregister program
                            ctx.logging.info("Evicting shader: " + hash);
                            programToEvict.destroy();
                            programs[programToEvict.hash] = null;
                            return true;
                        }
                        return false;   // Couldnt find suitable program to delete
                    });

            function activateProgram() {
                if (!canvas) {
                    throw new SceneJS.exceptions.NoCanvasActiveException("No canvas active");
                }

                if (!sceneHash) {
                    generateHash();
                }

                if (!activeProgram || activeProgram.hash != sceneHash) {
                    if (activeProgram) {
                        canvas.context.flush();
                        activeProgram.unbind();
                        activeProgram = null;
                        ctx.events.fireEvent(SceneJS._eventTypes.SHADER_DEACTIVATED);
                    }

                    if (!programs[sceneHash]) {
                        ctx.logging.info("Creating shader: '" + sceneHash + "'");
                        ctx.memory.allocate(
                                "shader",
                                function() {
                                    programs[sceneHash] = new SceneJS._webgl.Program(
                                            sceneHash,
                                            time,
                                            canvas.context,
                                            [composeVertexShader()],
                                            [composeFragmentShader()],
                                            ctx.logging);
                                });
                    }
                    activeProgram = programs[sceneHash];
                    activeProgram.lastUsed = time;
                    activeProgram.bind();
                    ctx.events.fireEvent(SceneJS._eventTypes.SHADER_ACTIVATED);
                }

                ctx.events.fireEvent(SceneJS._eventTypes.SHADER_RENDERING);
            }

            /** Generates a shader hash code from current rendering state.
             */
            function generateHash() {
                var val = [
                    canvas.canvasId,
                    ";",
                    (texture && rendererState.enableTexture2D) ? "tex=yes;" : "tex=no;"
                ];

                /* Lighting
                 */
                val.push("lights=[");
                for (var i = 0; i < lights.length; i++) {
                    var light = lights[i];
                    if (i > 0) {
                        val.push(",");
                    }
                    val.push("{");
                    val.push(light.type);
                    val.push(";");
                    if (light.specular) {
                        val.push("specular;");
                    }
                    if (light.diffuse) {
                        val.push("diffuse;");
                    }
                    val.push("}");
                }
                val.push("];");

                /* Fog
                 */
                if (fog) {
                    val.push("fog={mode:");
                    val.push(fog.mode);
                    val.push("};");
                }
                sceneHash = val.join("");
            }

            /**
             * Generic vertex shader, outputs:
             *
             *      Vertex in view-space
             *      Normal in view-space
             *      Direction of each light position from view-space vertex
             *      Direction of vertex from eye position
             */
            function composeVertexShader() {

                var texturing = texture && rendererState.enableTexture2D;

                var src = ["\n"];
                src.push("attribute vec3 aVertex;");                // World
                src.push("attribute vec3 aNormal;");                // World
                if (texturing) {
                    src.push("attribute vec2 aTextureCoord;");      // World
                }
                src.push("uniform mat4 uMMatrix;");               // Model
                src.push("uniform mat4 uMNMatrix;");              // Model Normal
                src.push("uniform mat4 uVMatrix;");               // View
                src.push("uniform mat4 uVNMatrix;");              // View Normal
                src.push("uniform mat4 uPMatrix;");               // Projection

                for (var i = 0; i < lights.length; i++) {
                    src.push("uniform vec4 uLightPos" + i + ";");
                }
                src.push("varying vec4 vViewVertex;");
                src.push("varying vec3 vNormal;");
                src.push("varying vec3 vEyeVec;");
                if (texturing) {
                    src.push("varying vec2 vTextureCoord;");
                }
                for (var i = 0; i < lights.length; i++) {
                    src.push("varying vec3 vLightVec" + i + ";");
                    src.push("varying float vLightDist" + i + ";");
                }
                src.push("void main(void) {");
                src.push("  vec4 tmpVNormal = uVNMatrix * (uMNMatrix * vec4(aNormal, 1.0)); ");
                src.push("  vNormal = normalize(tmpVNormal.xyz);");                                 // View-space normal
                src.push("  vViewVertex = uVMatrix * (uMMatrix * vec4(aVertex, 1.0)); ");
                src.push("  gl_Position = uPMatrix * vViewVertex;");

                src.push("  vec3 tmpVec;");
                for (var i = 0; i < lights.length; i++) {
                    src.push("tmpVec = (uLightPos" + i + ".xyz - vViewVertex.xyz);");
                    src.push("vLightVec" + i + " = tmpVec;");                   // Vector from light to vertex
                    src.push("vLightDist" + i + " = length(tmpVec);");          // Distance from light to vertex
                }
                src.push("vEyeVec = normalize(-vViewVertex.xyz);");
                if (texturing) {
                    src.push("vTextureCoord = aTextureCoord;");
                }
                src.push("}");
                return src.join("\n");
            }


            /**
             * Generates a fragment shader script for current scene state.
             */
            function composeFragmentShader() {

                var texturing = texture && rendererState.enableTexture2D;

                var src = ["\n"];

                // ------------ Inputs ----------------------------------------------

                src.push("uniform vec3 uAmbient;");                 // Scene ambient colour
                src.push("varying vec4 vViewVertex;");              // View-space vertex
                src.push("varying vec3 vNormal;");                  // View-space normal
                src.push("varying vec3 vEyeVec;");                  // Direction of view-space vertex from eye

                if (texturing) {
                    src.push("varying vec2 vTextureCoord;");
                }

                if (lights) {
                    for (var i = 0; i < lights.length; i++) {
                        var light = lights[i];

                        src.push("uniform vec3  uLightAmbient" + i + ";");
                        src.push("uniform vec3  uLightDiffuse" + i + ";");
                        src.push("uniform vec3  uLightSpecular" + i + ";");

                        src.push("uniform vec4  uLightPos" + i + ";");
                        src.push("uniform vec3  uLightSpotDir" + i + ";");

                        if (light.type == "spot") {
                            src.push("uniform float  uLightSpotCosCutOff" + i + ";");
                            src.push("uniform float  uLightSpotExp" + i + ";");
                        }

                        src.push("uniform vec3  uLightAttenuation" + i + ";");

                        src.push("varying vec3   vLightVec" + i + ";");     // Vector from light to vertex
                        src.push("varying float  vLightDist" + i + ";");    // Distance from light to vertex
                    }
                }

                src.push("uniform vec3  uMaterialAmbient;");
                src.push("uniform vec3  uMaterialDiffuse;");
                src.push("uniform vec3  uMaterialSpecular;");
                src.push("uniform float uMaterialShininess;");
                src.push("uniform vec3  uMaterialEmission;");

                if (fog) {
                    src.push("uniform vec3  uFogColor;");
                    src.push("uniform float uFogDensity;");
                    src.push("uniform float uFogStart;");
                    src.push("uniform float uFogEnd;");
                }

                src.push("void main(void) {");

                src.push("  float   attenuation = 1.0;");
                src.push("  vec3    ambientValue=uAmbient;");
                src.push("  vec3    diffuseValue=vec3(0.0,0.0,0.0);");
                src.push("  vec3    specularValue=vec3(0.0,0.0,0.0);");

                src.push("  vec3    lightVec;");
                src.push("  float   dotN;");
                src.push("  float   spotFactor;");
                src.push("  float   pf;");

                src.push("  float alpha = 0.6;");

                for (var i = 0; i < lights.length; i++) {
                    src.push("lightVec = normalize(vLightVec" + i + ");");

                    if (lights[i].type == "point") {

                        /* Point light
                         */
                        src.push("dotN = max(dot(vNormal, -lightVec), 0.0);");

                        src.push("if (dotN > 0.0) {");

                        src.push("attenuation = 1.0 / (" +
                                 "uLightAttenuation" + i + "[0] + " +
                                 "uLightAttenuation" + i + "[1] * vLightDist" + i + " + " +
                                 "uLightAttenuation" + i + "[2] * vLightDist" + i + " * vLightDist" + i + ");");

                        src.push("diffuseValue += dotN *  uLightDiffuse" + i + " * attenuation;");

                        src.push("}");

                        if (material.shininess > 0.0) {
                            src.push("pf = pow(max(dot(reflect(-lightVec, vNormal), vEyeVec), 0.0), uMaterialShininess);\n");
                            src.push("specularValue += uLightSpecular" + i + "  * attenuation * pf;");
                        }

                    } else if (lights[i].type == "spot") {

                        /* Spot light
                         */
                        src.push("spotFactor = dot(-lightVec, -normalize(uLightSpotDir" + i + "));");

                        src.push("if (spotFactor > uLightSpotCosCutOff" + i + ") {\n");

                        src.push("spotFactor = pow(spotFactor, uLightSpotExp" + i + ");");

                        src.push("dotN = max(dot(vNormal,lightVec),0.0);\n");

                        src.push("if(dotN>0.0){\n");

                        src.push("attenuation = spotFactor / (" +
                                 "uLightAttenuation" + i + "[0] + " +
                                 "uLightAttenuation" + i + "[1] * vLightDist" + i + " + " +
                                 "uLightAttenuation" + i + "[2] * vLightDist" + i + " * vLightDist" + i + ");\n");

                        src.push("diffuseValue += dotN *  uLightDiffuse" + i + " * attenuation;");

                        if (material.shininess > 0.0) {
                            src.push("pf = pow(max(dot(reflect(-lightVec, vNormal), vEyeVec), 0.0), uMaterialShininess);\n");
                            src.push("specularValue += uLightSpecular" + i + "  * attenuation * pf;");
                        }

                        src.push("}\n");
                        src.push("}\n");

                    } else if (lights[i].type == "dir") {

                        /* Directional light
                         */

                        if (lights[i].type == "dir") {
                            src.push("dotN = max(dot(vNormal, -lightDir" + i + "), 0.0);");

                            src.push("diffuseValue += dotN *  uLightDiffuse" + i + ";");
                            if (material.shininess > 0.0) {
                                src.push("pf = pow(max(dot(reflect(-lightVec, vNormal), vEyeVec), 0.0), uMaterialShininess);\n");
                                src.push("specularValue += uLightSpecular" + i + " * pf;");
                            }
                        }
                    }
                    src.push("ambientValue += uLightAmbient" + i + ";");
                }
                if (lights.length > 0) {
                    src.push("ambientValue /= " + lights.length + ";");
                }

                src.push("float fogFact=0.0;");
                if (fog) {

                    if (fog.mode == "exp") {
                        src.push("fogFact=clamp(pow(max((uFogEnd - length(-vViewVertex.xyz)) / (uFogEnd - uFogStart), 0.0), 2.0), 0.0, 1.0);\n");
                    } else if (fog.mode == "linear") {
                        src.push("fogFact=clamp((uFogEnd - length(-vViewVertex.xyz)) / (uFogEnd - uFogStart), 0.0, 1.0);\n");
                    }
                    src.push("gl_FragColor = vec4(uMaterialEmission + (ambientValue * uMaterialAmbient) + (diffuseValue  * uMaterialDiffuse) + (specularValue  * uMaterialSpecular) , 1) * fogFact + vec4(uFogColor, 1) * (1.0 - fogFact);  ");
                } else {
                    src.push("gl_FragColor = vec4(uMaterialEmission + (ambientValue * uMaterialAmbient) + (diffuseValue  * uMaterialDiffuse) + (specularValue  * uMaterialSpecular) , 1);  ");
                }
                //  src.push(  "    gl_FragColor = vec4(0, 0, 1.0, 1.0);  ");
                src.push("}");

                return src.join("\n");
            }
        });