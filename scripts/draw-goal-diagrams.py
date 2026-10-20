"""Render the Google Doc / GOAL_LOOP.md flowcharts. Requires Pillow and CJK fonts.

Run: python3 scripts/draw-goal-diagrams.py
On non-macOS, set DIAGRAM_FONT and DIAGRAM_BOLD_FONT to CJK font files.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import os
import math

OUT = Path(__file__).resolve().parents[1] / "plugins/agent-bridge/docs/diagrams"
OUT.mkdir(parents=True, exist_ok=True)
FONT = os.environ.get("DIAGRAM_FONT", "/System/Library/Fonts/STHeiti Light.ttc")
BOLD = os.environ.get("DIAGRAM_BOLD_FONT", "/System/Library/Fonts/STHeiti Medium.ttc")
INK = "#1D3348"
MUTED = "#536C80"
BLUE = "#316CAD"
GREEN = "#2C866B"
ORANGE = "#B86C20"
PURPLE = "#7A64A6"
S = 2

def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size*S)

def canvas(w, h):
    return Image.new("RGB", (w*S, h*S), "white")

def text(im, x, y, value, size=36, color=INK, anchor="mm", bold=False):
    ImageDraw.Draw(im).text((x*S, y*S), value, font=font(size, bold), fill=color, anchor=anchor)

def box(im, x, y, w, h, title, subtitle="", color=BLUE, fill="#EEF5FC", title_size=39):
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((x*S,y*S,(x+w)*S,(y+h)*S), radius=17*S, fill=fill, outline=color, width=2*S)
    text(im,x+w/2,y+h/2-(21 if subtitle else 0),title,title_size,color,bold=True)
    if subtitle:
        text(im,x+w/2,y+h/2+30,subtitle,29,MUTED)

def arrow(im, points, color=BLUE, width=3, head=True, dashed=False):
    d = ImageDraw.Draw(im)
    for (x1,y1),(x2,y2) in zip(points,points[1:]):
        length=math.hypot(x2-x1,y2-y1)
        if dashed:
            for a in range(0,math.ceil(length),18):
                b=min(a+10,length)
                d.line(((x1+(x2-x1)*a/length)*S,(y1+(y2-y1)*a/length)*S,
                        (x1+(x2-x1)*b/length)*S,(y1+(y2-y1)*b/length)*S),fill=color,width=width*S)
        else:
            d.line((x1*S,y1*S,x2*S,y2*S),fill=color,width=width*S)
    if head:
        (x1,y1),(x2,y2)=points[-2:]
        a=math.atan2(y2-y1,x2-x1)
        pts=[(x2*S,y2*S)]
        for sign in [-1,1]:
            pts.append(((x2-15*math.cos(a)+sign*7*math.sin(a))*S,
                        (y2-15*math.sin(a)-sign*7*math.cos(a))*S))
        d.polygon(pts,fill=color)

def label(im,x,y,value,color=BLUE,size=29):
    d=ImageDraw.Draw(im)
    b=d.textbbox((x*S,y*S),value,font=font(size),anchor="mm")
    d.rectangle((b[0]-7*S,b[1]-4*S,b[2]+7*S,b[3]+4*S),fill="white")
    text(im,x,y,value,size,color)

# Figure 1: the design gate is distinct from implementation acceptance.
im=canvas(1400,1120)
text(im,55,42,"Agent Loop：先确定分工，再推进目标",40,anchor="lm",bold=True)
text(im,55,94,"下放强度、模型推理强度、并发上限分别配置。",29,MUTED,anchor="lm")
box(im,410,140,580,110,"目标、范围与完成标准","创建目标时固定下放强度",title_size=35)
arrow(im,[(700,250),(700,285)],head=False)
arrow(im,[(320,285),(1080,285)],head=False)
arrow(im,[(320,285),(320,325)])
arrow(im,[(1080,285),(1080,325)])
label(im,320,285,"low / medium",size=28)
label(im,1080,285,"high / max",size=28)
box(im,60,325,520,120,"宿主设计与拆分","worker 按分配范围协助",title_size=35)
box(im,820,325,520,120,"worker 先设计与拆分","只读设计，输出方案与验证计划",GREEN,"#EDF8F3",35)
arrow(im,[(1080,445),(1080,500)])
box(im,820,500,520,110,"宿主审核设计版本","批准后才能启动对应任务",title_size=35)
arrow(im,[(1340,555),(1370,555),(1370,385),(1340,385)],ORANGE)
label(im,1270,472,"退回修改",ORANGE,27)
arrow(im,[(320,445),(320,695),(410,695)])
arrow(im,[(1080,610),(1080,695),(990,695)])
label(im,1080,648,"通过",size=26)
box(im,410,640,580,110,"按计划执行与自测","max：实现与返修都交给 worker",GREEN,"#EDF8F3",35)
arrow(im,[(700,750),(700,825)])
box(im,180,825,1040,120,"宿主验收 → 串行集成 → 整体验收","检查实际产物与证据，最终以集成版本为准",title_size=36)
arrow(im,[(1220,885),(1370,885),(1370,695),(990,695)],ORANGE)
label(im,1310,785,"返修",ORANGE,29)
arrow(im,[(700,945),(700,987)],GREEN)
box(im,180,987,1040,65,"整体标准全部通过 → 目标完成","",GREEN,"#EDF8F3",32)
text(im,700,1090,"暂停、等待输入、取消或预算耗尽：停止推进，不自动降档或接手。",28,MUTED)
im.save(OUT/"agent-loop-flow.png",dpi=(300,300))

# Figure 2: max reserves host effort for review; implementation artifacts stay worker-owned.
im=canvas(1400,1130)
text(im,55,42,"并行任务：分工随下放强度调整",40,anchor="lm",bold=True)
text(im,55,94,"示例：1 个宿主 + 2 个 worker；并发数不由下放强度决定。",28,MUTED,anchor="lm")
box(im,60,145,1280,95,"high / max：先完成 worker 设计与宿主审核","获批的任务版本、依赖和范围进入任务池",title_size=35)
box(im,360,295,680,110,"宿主调度 + 任务池","依赖满足、修改范围不重叠、名额可用",title_size=36)
arrow(im,[(700,240),(700,295)])
arrow(im,[(700,405),(700,435)],head=False)
arrow(im,[(250,435),(1150,435)],head=False)
for x in [250,700,1150]:arrow(im,[(x,435),(x,480)])
box(im,60,480,380,140,"宿主任务区","low ~ high 可参与实现",title_size=34)
label(im,250,652,"max：只审核和验证",BLUE,27)
box(im,510,480,380,140,"worker 1 工作区","后端实现与自测",GREEN,"#EDF8F3",32)
box(im,960,480,380,140,"worker 2 工作区","前端实现与自测",GREEN,"#EDF8F3",32)
arrow(im,[(250,620),(250,720)])
arrow(im,[(700,620),(700,720)])
arrow(im,[(1150,620),(1150,720)])
box(im,60,720,380,115,"若宿主有代码修改","另一个 worker 只读评审",PURPLE,"#F4F0FA",29)
box(im,510,720,380,115,"宿主核验","检查固定产物与测试证据",title_size=34)
box(im,960,720,380,115,"宿主核验","检查固定产物与测试证据",title_size=34)
arrow(im,[(250,835),(250,875),(700,875)],head=False)
arrow(im,[(1150,835),(1150,875),(700,875)],head=False)
arrow(im,[(700,835),(700,925)])
box(im,310,925,780,115,"验收通过后，逐项串行集成","更新基线、解锁下游，最后整体验收",GREEN,"#EDF8F3",35)
arrow(im,[(310,985),(28,985),(28,350),(360,350)],GREEN)
text(im,700,1080,"不通过：宿主说明问题和验证方法，worker 返修后重新提交。",28,MUTED)
text(im,700,1112,"宿主转发轮次间消息；设计、实现、评审与返修共用累计预算。",27,MUTED)
im.save(OUT/"parallel-tasks-flow.png",dpi=(300,300))
for file in ["agent-loop-flow.png", "parallel-tasks-flow.png"]: print(OUT/file)
