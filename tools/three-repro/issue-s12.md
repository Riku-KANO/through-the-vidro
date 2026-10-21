# three.js への報告の下書き（S-12）

投稿は発案者が行う（公開の操作）。本家の担当者は「エラーの報告だけで十分」としている（#34324）ので、直し方の案は書かない。
Live example の欄は、本家の issue テンプレートにある jsfiddle（WebGPURenderer、dev）に下の Code を貼って作ったリンクに置き換える。

---

**Title:** WebGPURenderer: transmissive mesh hidden during a resize renders with a destroyed backdrop texture when shown again

### Description

A mesh with a transmissive `MeshPhysicalNodeMaterial` (no node properties) that is not drawn while the drawing buffer size
goes A → B → A keeps sampling the destroyed transmission backdrop when it is drawn again.

- WebGPU: `Destroyed texture [Texture (unlabeled 640x360 px, TextureFormat::RGBA16Float)] used in a submit.` on every frame
  after the mesh becomes visible again; the frame is not rendered.
- WebGL (`forceWebGL: true`): `WebGL: INVALID_OPERATION: bindTexture: attempt to use a deleted object` on every frame.

Another transmissive mesh with the same material stays visible the whole time, so the backdrop is re-created at size B and
again at size A while the hidden mesh is not drawn. When it reappears, the size matches the size of its last draw, so it is
not refreshed.

Giving the material any node property avoids it (e.g. `glass.thicknessNode = materialThickness`, same value as the
default). Possibly related: #34324, #34612.

### Reproduction steps

1. Render two meshes sharing one transmissive material for a few frames.
2. Hide one of them (`visible = false`).
3. `renderer.setPixelRatio( 0.75 )`, render a few frames, then `renderer.setPixelRatio( 1 )`, render a few frames.
4. Show the hidden mesh again. The errors above appear on every following frame.

### Code

```js
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer();
renderer.setSize( 640, 360 );
document.body.appendChild( renderer.domElement );
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x335577 );
scene.add( new THREE.HemisphereLight( 0xffffff, 0x444444, 2 ) );

const camera = new THREE.PerspectiveCamera( 50, 640 / 360, 0.1, 100 );
camera.position.set( 0, 0, 5 );

const box = new THREE.Mesh( new THREE.BoxGeometry( 2, 2, 2 ), new THREE.MeshBasicNodeMaterial( { color: 0xff8800 } ) );
box.position.set( 0, 0, - 3 );
scene.add( box );
camera.lookAt( 0, 0, - 3 );

const glass = new THREE.MeshPhysicalNodeMaterial( { transmission: 1, roughness: 0, thickness: 0.5 } );
const geometry = new THREE.SphereGeometry( 0.8, 32, 16 );
const first = new THREE.Mesh( geometry, glass ); // stays visible
first.position.set( - 1, 0, 0 );
const second = new THREE.Mesh( geometry, glass ); // hidden during the resize
second.position.set( 1, 0, 0 );
scene.add( first, second );

const steps = [
	[ 10, () => {} ],
	[ 10, () => { second.visible = false; } ],
	[ 10, () => { renderer.setPixelRatio( 0.75 ); } ],
	[ 10, () => { renderer.setPixelRatio( 1 ); } ],
	[ 30, () => { second.visible = true; } ], // errors on every frame from here
];

let step = 0, left = 0;

renderer.setAnimationLoop( () => {

	if ( left === 0 ) {

		if ( step >= steps.length ) return renderer.setAnimationLoop( null );
		const [ frames, action ] = steps[ step ++ ];
		action();
		left = frames;

	}

	left --;
	renderer.render( scene, camera );

} );
```

### Live example

- jsfiddle（dev）: （作成したリンク）

### Version

r186 (0.186.1). Also on `dev` (r187dev build of 2026-10-21).

### Device

Desktop

### Browser

Chrome (Chromium 156)

### OS

MacOS (26.6, Apple M5 Pro)
