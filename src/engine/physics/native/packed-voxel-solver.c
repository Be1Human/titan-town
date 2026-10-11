/* Independently owned port of packed-voxel-solver.js working-array semantics.
 * Original project code. No libc or WASI imports.
 * Build without contraction, reassociation, or fast-math. */
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;
typedef union {float f;u32 u;} bits;
typedef struct {u32 bodyStart,bodyCount,constraintStart,constraintCount;} group;

static float jsmin(float a,float b){
 if(a!=a||b!=b)return __builtin_nanf("");
 if(a==0.0f&&b==0.0f){bits x={.f=a},y={.f=b},r={.u=(x.u|y.u)&0x80000000u};return r.f;}
 return a<b?a:b;
}
static float jsmax(float a,float b){
 if(a!=a||b!=b)return __builtin_nanf("");
 if(a==0.0f&&b==0.0f){bits x={.f=a},y={.f=b},r={.u=(x.u&y.u)&0x80000000u};return r.f;}
 return a>b?a:b;
}
static int finite(float a){bits v={.f=a};return(v.u&0x7f800000u)!=0x7f800000u;}
static void row(float*v,const float*mass,float*r,const i32*indices,u8*saturated,u32 fixed,u32 c,u32 j,float limit,int normal){
 const u32 at=c*54+j*18,a=indices[c*2],b=indices[c*2+1],va=a*6,vb=b*6;
 float jv=0.0f;
 for(u32 k=0;k<3;k++){
  const float dv=v[va+k]-v[vb+k],linear=r[at+k]*dv;
  jv=jv+linear;const float aa=r[at+3+k]*v[va+3+k];jv=jv+aa;
  const float bb=r[at+6+k]*v[vb+3+k];jv=jv-bb;
 }
 float delta=r[at+16]!=0.0f?(r[at+15]-jv)/r[at+16]:0.0f;
 float lambda=r[at+17]+delta;const float lower=normal?0.0f:-limit;
 if(lambda<lower||lambda>limit){lambda=jsmax(lower,jsmin(limit,lambda));delta=lambda-r[at+17];if(normal&&lambda>=limit&&finite(limit))saturated[c]=1;}
 r[at+17]=lambda;if(delta==0.0f)return;
 for(u32 k=0;k<3;k++){
  if(a>=fixed){const float m=r[at+k]*mass[a],d=m*delta;v[va+k]=v[va+k]+d;const float w=r[at+9+k]*delta;v[va+3+k]=v[va+3+k]+w;}
  if(b>=fixed){const float m=r[at+k]*mass[b],d=m*delta;v[vb+k]=v[vb+k]-d;const float w=r[at+12+k]*delta;v[vb+3+k]=v[vb+3+k]-w;}
 }
}
__attribute__((export_name("solve")))
void solve(float*v,const float*mass,const float*angularMin,const float*angularMax,float*data,const i32*indices,const u8*kind,const float*cap,const float*friction,u8*saturated,const group*groups,u32 count,u32 fixed){
 for(u32 g=0;g<count;g++)for(u32 iteration=0;iteration<8;iteration++){
  const group work=groups[g];
  for(u32 c=work.constraintStart;c<work.constraintStart+work.constraintCount;c++){
   if(kind[c]){for(u32 j=0;j<3;j++)row(v,mass,data,indices,saturated,fixed,c,j,__builtin_inff(),0);}
   else{row(v,mass,data,indices,saturated,fixed,c,0,cap[c],1);const float limit=friction[c]*data[c*54+17];row(v,mass,data,indices,saturated,fixed,c,1,limit,0);row(v,mass,data,indices,saturated,fixed,c,2,limit,0);}
  }
  for(u32 b=work.bodyStart;b<work.bodyStart+work.bodyCount;b++)for(u32 k=0;k<3;k++)v[b*6+3+k]=jsmax(angularMin[b*3+k],jsmin(angularMax[b*3+k],v[b*6+3+k]));
 }
}
