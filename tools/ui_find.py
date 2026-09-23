#!/usr/bin/env python3
"""Print the center "x y" of the first UI node whose text or content-desc equals the label (uiautomator dump)."""
import re, sys, xml.etree.ElementTree as ET
xml_path, label = sys.argv[1], sys.argv[2]
exact = [n for n in ET.parse(xml_path).iter("node") if label in (n.get("text"), n.get("content-desc"))]
if not exact:
    sys.exit(1)
x1, y1, x2, y2 = map(int, re.findall(r"\d+", exact[-1].get("bounds")))
print((x1 + x2) // 2, (y1 + y2) // 2)
