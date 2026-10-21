import * as THREE from 'three';
import { materialThickness } from 'three/tsl';

// Two meshes share one transmissive material without node properties. The right one is hidden while the
// drawing buffer goes 1 -> 0.75 -> 1 (pixel ratio). When it is shown again, every frame fails on WebGPU:
// "Destroyed texture [...] used in a submit." (WebGL backend: "bindTexture: attempt to use a deleted object").

const info = document.getElementById( 'info' );

const renderer = new THREE.WebGPURenderer();
renderer.setSize( 640, 360 );
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x335577 );
scene.add( new THREE.HemisphereLight( 0xffffff, 0x444444, 2 ) ); // a light is needed for transmission

const camera = new THREE.PerspectiveCamera( 50, 640 / 360, 0.1, 100 );
camera.position.set( 0, 0, 5 );

const box = new THREE.Mesh( new THREE.BoxGeometry( 2, 2, 2 ), new THREE.MeshBasicNodeMaterial( { color: 0xff8800 } ) );
box.position.set( 0, 0, - 3 );
scene.add( box );
camera.lookAt( 0, 0, - 3 );

const glass = new THREE.MeshPhysicalNodeMaterial( { transmission: 1, roughness: 0, thickness: 0.5 } );
// glass.thicknessNode = materialThickness; // any node property avoids the errors (same value as the default)

const geometry = new THREE.SphereGeometry( 0.8, 32, 16 );
const first = new THREE.Mesh( geometry, glass ); // stays visible
first.position.set( - 1, 0, 0 );
const second = new THREE.Mesh( geometry, glass ); // hidden during the resize
second.position.set( 1, 0, 0 );
scene.add( first, second );

const steps = [
	[ 'both visible', 10, () => {} ],
	[ 'right sphere hidden', 10, () => { second.visible = false; } ],
	[ 'pixel ratio 0.75', 10, () => { renderer.setPixelRatio( 0.75 ); } ],
	[ 'pixel ratio 1', 10, () => { renderer.setPixelRatio( 1 ); } ],
	[ 'right sphere visible again (errors on every frame from here)', 30, () => { second.visible = true; } ],
];

let step = 0, left = 0;

renderer.setAnimationLoop( () => {

	if ( left === 0 ) {

		if ( step >= steps.length ) {

			renderer.setAnimationLoop( null );
			info.textContent += ' - done';
			return;

		}

		const [ name, frames, action ] = steps[ step ++ ];
		info.textContent = `r${ THREE.REVISION } - ${ name }`;
		action();
		left = frames;

	}

	left --;
	renderer.render( scene, camera );

} );
