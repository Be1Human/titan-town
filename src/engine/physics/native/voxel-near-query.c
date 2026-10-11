/* Independent double-precision port of current matrix voxel-near-phase.js.
 * Exact JS hypot is imported; all other arithmetic keeps its original order.
 * No contact cap. Insufficient output/scratch signals a full retry/fallback. */
typedef unsigned int u32;typedef int i32;typedef unsigned char u8;
typedef struct {i32 x,y,z;u32 width,height,depth,layer,mask,planes,rows,offsets,xs,surfaceOffsets,surfaceXs;} cache;
typedef struct {double x,y,z;} vec;
__attribute__((import_module("math"),import_name("hypot3"))) extern double hypot3(double,double,double);
static const u8 classes[64]={0,2,2,2,2,1,1,1,2,1,1,1,2,1,1,1,2,1,1,1,1,3,3,3,1,3,3,3,1,3,3,3,2,1,1,1,1,3,3,3,1,3,3,3,1,3,3,3,2,1,1,1,1,3,3,3,1,3,3,3,1,3,3,3};
static i32 imin(i32 a,i32 b){return a<b?a:b;}static i32 imax(i32 a,i32 b){return a>b?a:b;}
static vec mv(const double*m,vec v){return(vec){v.x*m[0]+v.y*m[3]+v.z*m[6],v.x*m[1]+v.y*m[4]+v.z*m[7],v.x*m[2]+v.y*m[5]+v.z*m[8]};}
static vec mp(const double*m,vec v){vec r=mv(m,v);r.x+=m[9];r.y+=m[10];r.z+=m[11];return r;}
static vec sp(const double*m,vec v){v.x-=m[9];v.y-=m[10];v.z-=m[11];return(vec){v.x*m[0]+v.y*m[1]+v.z*m[2],v.x*m[3]+v.y*m[4]+v.z*m[5],v.x*m[6]+v.y*m[7]+v.z*m[8]};}
static double dmin(double a,double b){if(a!=a||b!=b)return __builtin_nan("");if(a==0&&b==0)return __builtin_signbit(a)||__builtin_signbit(b)?-0.0:0.0;return a<b?a:b;}
static double dmax(double a,double b){if(a!=a||b!=b)return __builtin_nan("");if(a==0&&b==0)return __builtin_signbit(a)&&__builtin_signbit(b)?-0.0:0.0;return a>b?a:b;}
static int segment(vec a,vec b,const double*box,double eps,vec*hit){
 double enter=-__builtin_inf(),exit=__builtin_inf(),aa[3]={a.x,a.y,a.z},bb[3]={b.x,b.y,b.z};
 for(int j=0;j<3;j++){double d=bb[j]-aa[j],lo=box[j]-eps,hi=box[j+3]+eps;if(d==0){if(aa[j]<lo||aa[j]>hi)return 0;continue;}double t1=(lo-aa[j])/d,t2=(hi-aa[j])/d;enter=dmax(enter,dmin(t1,t2));exit=dmin(exit,dmax(t1,t2));}
 if(!(enter<exit&&exit>0&&enter<1))return 0;double start=dmax(0,enter),end=dmin(1,exit);hit[0]=(vec){a.x+(b.x-a.x)*start,a.y+(b.y-a.y)*start,a.z+(b.z-a.z)*start};hit[1]=(vec){a.x+(b.x-a.x)*end,a.y+(b.y-a.y)*end,a.z+(b.z-a.z)*end};return 1;
}
__attribute__((export_name("cellRange")))
int cellRange(const double*pa,const double*pb,const double*rawA,const double*rawB,double margin,double eps,double cell,double*out){
 double boxes[2][6];for(int j=0;j<3;j++){boxes[0][j]=rawA[j]-margin;boxes[0][j+3]=rawA[j+3]+margin;boxes[1][j]=rawB[j]-margin;boxes[1][j+3]=rawB[j+3]+margin;out[j]=__builtin_inf();out[j+3]=-__builtin_inf();}
 for(int pass=0;pass<2;pass++){
  vec corners[8];const double*box=pass?boxes[0]:boxes[1];
  for(int i=0;i<8;i++){vec p={box[i&1?3:0],box[i&2?4:1],box[i&4?5:2]};corners[i]=pass?sp(pb,mp(pa,p)):sp(pa,mp(pb,p));}
  for(int bit=1;bit<=4;bit<<=1)for(int i=0;i<8;i++)if(!(i&bit)){vec hit[2];if(segment(corners[i],corners[i|bit],pass?boxes[1]:boxes[0],eps,hit))for(int k=0;k<2;k++){vec p=pass?sp(pa,mp(pb,hit[k])):hit[k];double values[3]={p.x,p.y,p.z};for(int j=0;j<3;j++){out[j]=dmin(out[j],values[j]);out[j+3]=dmax(out[j+3],values[j]);}}}
 }
 if(out[0]==__builtin_inf())return 0;for(int j=0;j<6;j++)out[j]=__builtin_floor(out[j]/cell);return 1;
}
static double dot(vec a,vec b){return a.x*b.x+a.y*b.y+a.z*b.z;}
static vec clip(vec v,u8 mask){if((v.x<0&&!(mask&1))||(v.x>0&&!(mask&2)))v.x=0;if((v.y<0&&!(mask&4))||(v.y>0&&!(mask&8)))v.y=0;if((v.z<0&&!(mask&16))||(v.z>0&&!(mask&32)))v.z=0;return v;}
static u32 lower(const u32*xs,u32 lo,u32 hi,i32 x){while(lo<hi){u32 mid=(lo+hi)>>1;if((i32)xs[mid]<x)lo=mid+1;else hi=mid;}return lo;}
static void emit(double*out,u32 cap,u32*n,u32 i,u32 j,vec outward,vec center,double penetration,int reverse,int fast,double offset){
 u32 at=(*n)++;if(at>=cap)return;double*r=out+at*10;r[0]=reverse?j:i;r[1]=reverse?i:j;r[2]=reverse?outward.x:-outward.x;r[3]=reverse?outward.y:-outward.y;r[4]=reverse?outward.z:-outward.z;r[5]=center.x+outward.x*offset;r[6]=center.y+outward.y*offset;r[7]=center.z+outward.z*offset;r[8]=penetration;r[9]=fast;
}
__attribute__((export_name("query")))
u32 query(const cache*a,const cache*b,const double*c,double*out,u32 cap,double*normals,u32 normCap,u32*stats){
 const u8*am=(const u8*)a->mask,*bm=(const u8*)b->mask,*planes=(const u8*)a->planes,*rows=(const u8*)a->rows;const u32*offsets=(const u32*)a->offsets,*xs=(const u32*)a->xs;
 const double sa=c[0],sb=c[1],*pa=c+2,*pb=c+14,*relative=c+26,*backward=c+38,*alternate=c+47;const int haveAlt=c[59]!=0,fast=c[60]!=0,reverse=c[61]!=0,edges=c[62]!=0;
 const i32 lx=(i32)c[63],ly=(i32)c[64],lz=(i32)c[65],hx=(i32)c[66],hy=(i32)c[67],hz=(i32)c[68];const double distance2=c[69],offset=c[70],radius=c[71],similarity=c[72],margin=c[73],fastSep=c[74];u32 emitted=0;stats[0]=stats[1]=stats[2]=stats[3]=0;
 for(i32 z=imax(0,lz-a->z);z<=imin(a->depth-1,hz-a->z);z++){
  i32 lowY=imax(imax(0,ly-a->y),planes[z*2]),highY=imin(imin(a->height-1,hy-a->y),a->height-1-planes[z*2+1]);
  for(i32 y=lowY;y<=highY;y++){
   u32 row=y+z*a->height,start=offsets[row],end=offsets[row+1];i32 lowX=imax(imax(0,lx-a->x),rows[row*2]),highX=imin(imin(a->width-1,hx-a->x),a->width-1-rows[row*2+1]);if(start==end||lowX>highX)continue;
   for(u32 k=lower(xs,start,end,lowX);k<end&&(i32)xs[k]<=highX;k++){
    i32 x=xs[k];u32 i=x+z*a->width+y*a->layer;u8 maskA=am[i],category=classes[maskA&63];stats[0]++;if(!edges&&category!=3)continue;if(!(category&0xfd)||(category==1&&!edges))continue;
    vec ac={(x+a->x+.5)*sa,(y+a->y+.5)*sa,(z+a->z+.5)*sa},center=mp(pa,ac),local=mp(relative,ac);u32 normalCount=0;
    if(fast&&haveAlt){vec endpoint=mp(alternate,ac);double motion=hypot3(local.x-endpoint.x,local.y-endpoint.y,local.z-endpoint.z);
     if(motion>radius){i32 steps=imax(1,(i32)(motion/margin));for(i32 step=1;step<=steps;step++){
      double t=(double)step/steps;i32 bx=(i32)__builtin_floor(((1-t)*local.x+t*endpoint.x)/sb),by=(i32)__builtin_floor(((1-t)*local.y+t*endpoint.y)/sb),bz=(i32)__builtin_floor(((1-t)*local.z+t*endpoint.z)/sb);
      if(bx<b->x||by<b->y||bz<b->z||bx>=b->x+(i32)b->width||by>=b->y+(i32)b->height||bz>=b->z+(i32)b->depth)continue;
      u32 j=bx-b->x+(bz-b->z)*b->width+(by-b->y)*b->layer;u8 maskB=bm[j],kind=classes[maskB&63];if(!kind||(category==1&&kind!=1))continue;
      vec source=clip((vec){local.x-(bx+.5)*sb,local.y-(by+.5)*sb,local.z-(bz+.5)*sb},maskB),target=clip(mv(backward,(vec){-source.x,-source.y,-source.z}),maskA);double length=hypot3(target.x,target.y,target.z);if(length==0)continue;
      vec outward=mv(pa,(vec){target.x/length,target.y/length,target.z/length});emit(out,cap,&emitted,i,j,outward,center,-fastSep,reverse,1,offset);stats[1]++;
     }}
    }
    i32 loX=imax(b->x,(i32)__builtin_floor((local.x-radius)/sb)),hiX=imin(b->x+b->width-1,(i32)__builtin_floor((local.x+radius)/sb)),loY=imax(b->y,(i32)__builtin_floor((local.y-radius)/sb)),hiY=imin(b->y+b->height-1,(i32)__builtin_floor((local.y+radius)/sb)),loZ=imax(b->z,(i32)__builtin_floor((local.z-radius)/sb)),hiZ=imin(b->z+b->depth-1,(i32)__builtin_floor((local.z+radius)/sb));
    for(i32 by=loY;by<=hiY;by++)for(i32 bz=loZ;bz<=hiZ;bz++){
     u32 br=by-b->y+(bz-b->z)*b->height;const u32*bs=category==1?(const u32*)b->xs:(const u32*)b->surfaceXs,*bo=category==1?(const u32*)b->offsets:(const u32*)b->surfaceOffsets;
     for(u32 bk=lower(bs,bo[br],bo[br+1],loX-b->x);bk<bo[br+1];bk++){
      i32 bx=bs[bk]+b->x;if(bx>hiX)break;u32 j=bx-b->x+(bz-b->z)*b->width+(by-b->y)*b->layer;u8 maskB=bm[j],kind=classes[maskB&63];if(!kind||(category==1&&kind!=1))continue;stats[1]++;
      vec bc={(bx+.5)*sb,(by+.5)*sb,(bz+.5)*sb},diff={local.x-bc.x,local.y-bc.y,local.z-bc.z};if(dot(diff,diff)>=distance2)continue;
      vec source=clip(diff,maskB);if(dot(source,source)==0)continue;vec target=clip(mv(backward,(vec){-source.x,-source.y,-source.z}),maskA);double length=hypot3(target.x,target.y,target.z);if(!(length>0))continue;
      vec outward=mv(pa,(vec){target.x/length,target.y/length,target.z/length});int duplicate=0;for(u32 n=0;n<normalCount;n++){vec prior={normals[n*3],normals[n*3+1],normals[n*3+2]};if(dot(prior,outward)>similarity){duplicate=1;break;}}if(duplicate)continue;
      if(normalCount>=normCap){stats[3]=1;return emitted;}normals[normalCount*3]=outward.x;normals[normalCount*3+1]=outward.y;normals[normalCount*3+2]=outward.z;normalCount++;
      vec worldB=mp(pb,bc),delta={worldB.x-center.x,worldB.y-center.y,worldB.z-center.z};emit(out,cap,&emitted,i,j,outward,center,margin-dot(delta,outward),reverse,0,offset);
     }
    }
   }
  }
 }
 stats[2]=emitted;return emitted;
}
