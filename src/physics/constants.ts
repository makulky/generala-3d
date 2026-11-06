/** Medidas compartidas por la física y las mallas. Un dado mide 1 unidad. */
export const DIE_SIZE = 1;

export const TRAY_HALF = 6;
export const TRAY_RADIUS = 1.6;
export const RIM_INSET = 1.2;
export const FELT = { minX: -4.4, maxX: 4.4, minZ: -2.8, maxZ: 4.4 };
export const TABLE_Y = -0.4;
export const BAND_TOP_Y = 0.55;

export const SLOT_FLOOR_Y = 0.1;
export const SLOT_SIZE = 1.25;
export const SLOT_Z = -3.8;
export const SLOT_X = [-3, -1.5, 0, 1.5, 3];

export const CUP_INNER_R = 2.3;
export const CUP_OUTER_R = 2.9;
export const CUP_HEIGHT = 4.3;
export const CUP_FLOOR = 0.3;
/** Altura del aro del borde: la pared física llega hasta aquí para que nada lo cruce. */
export const CUP_RIM_TUBE = (CUP_OUTER_R - CUP_INNER_R) / 2;
export const CUP_RIM_TOP = CUP_HEIGHT + CUP_RIM_TUBE;

/** Sobre la bandeja, listo para tirar, como en el diseño. */
export const CUP_READY = { x: 4.5, y: 1.2, z: -0.2 };
/** Aparta el cubilete para que no tape los dados que han salido. */
export const CUP_ASIDE = { x: 7.4, y: 1, z: 1.5 };
/** Desde aquí no hay parte del cubilete sobre el fieltro: los dados pueden subir sin cruzarlo. */
export const CUP_LANE_X = 7.3;
/** Vuelco desde el lateral derecho, con la boca justo en el borde del fieltro. */
export const CUP_POUR = { x: 7.7, y: 5.1, minZ: -0.5, maxZ: 1.6 };
export const CUP_POUR_ANGLE = (108 * Math.PI) / 180;

/** Pose serializada: cubilete + 5 dados, cada uno con posición y cuaternión. */
export const POSE_FLOATS = 6 * 7;

/** Normal local de cada cara del dado. Las caras opuestas suman 7. */
export const FACE_NORMALS: Record<number, [number, number, number]> = {
  1: [1, 0, 0],
  6: [-1, 0, 0],
  2: [0, 1, 0],
  5: [0, -1, 0],
  3: [0, 0, 1],
  4: [0, 0, -1],
};
