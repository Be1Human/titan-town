// Gameplay durability at the 10 cm voxel scale, rather than real-world units.
// Key order is part of the imported map format; keep existing material IDs stable.
export const MATERIALS={
  plaster:{color:0xd9c6a0,strength:1.7,name:'灰泥',texture:'plaster',hardness:'较软',response:{hammer:1,shotgun:.8,explosion:1.15},sound:'stone'},
  stone:{color:0xbda67c,strength:4.2,name:'砂岩',texture:'plaster',hardness:'坚硬',response:{hammer:.72,shotgun:.3,explosion:1},sound:'stone'},
  brick:{color:0x9d8163,strength:3.2,name:'砌石',texture:'brick',hardness:'中等',response:{hammer:.9,shotgun:.5,explosion:1.1},sound:'stone'},
  concrete:{color:0xc6bc9e,strength:7,name:'混凝土',texture:'plaster',hardness:'很硬',response:{hammer:0,shotgun:.12,explosion:.95},sound:'stone'},
  wood:{color:0x938467,strength:.7,name:'木材',texture:'wood',hardness:'较软',response:{hammer:1.25,shotgun:1.1,explosion:1.3},sound:'wood'},
  darkwood:{color:0x736245,strength:1,name:'旧木门',texture:'wood',hardness:'较软',response:{hammer:1.1,shotgun:1,explosion:1.2},sound:'wood'},
  roof:{color:0xaf9e7e,strength:2.3,name:'屋顶',texture:'plaster',hardness:'中等',response:{hammer:.85,shotgun:.55,explosion:1.1},sound:'stone'},
  metal:{color:0x5c6c54,strength:9,name:'钢板',texture:'plaster',hardness:'很硬',response:{hammer:0,shotgun:.035,explosion:.9},sound:'metal'},
  rust:{color:0x918275,strength:4.8,name:'锈蚀铁皮',texture:'plaster',hardness:'坚硬',response:{hammer:.35,shotgun:.22,explosion:1},sound:'metal'},
  dark:{color:0x363a34,strength:11,name:'厚钢构件',hardness:'很硬',response:{hammer:0,shotgun:.02,explosion:.85},sound:'metal'},
  glass:{color:0x71908a,strength:.2,name:'玻璃',hardness:'易碎',response:{hammer:2,shotgun:2,explosion:1.5},sound:'glass'},
  leaf:{color:0x737654,strength:.16,name:'树叶',hardness:'易碎',response:{hammer:2,shotgun:2,explosion:1.5},sound:'wood'},
  fuel:{color:0x8d5539,strength:1.2,name:'燃油桶',hardness:'薄铁皮',response:{hammer:.45,shotgun:1.3,explosion:1.2},sound:'metal'}
};

export const ATTACKS={
  // Center the blow inside the wall: a 40 cm façade can be punched through,
  // while solid masonry still needs successive blows to excavate its depth.
  hammer:{power:1.6,radius:.30,penetration:.18,falloff:.38},
  shotgun:{power:.9,radius:.105,penetration:.025,falloff:.48,pellets:9},
  explosion:{power:18,radius:3.15,falloff:1.65}
};

export function impactEnergy(material,power,distanceFraction,kind='generic'){
  const fraction=Math.max(0,Math.min(1,distanceFraction));
  const falloff=kind==='explosion'?Math.pow(1-fraction,ATTACKS.explosion.falloff):1-fraction*(ATTACKS[kind]?.falloff??.4);
  return Math.max(0,power)*(MATERIALS[material]?.response[kind]??1)*falloff;
}

export function shotgunPower(distance){return ATTACKS.shotgun.power*Math.max(.25,1-Math.max(0,distance-8)/60);}
