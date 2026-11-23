#!/usr/bin/env python3
"""Parametric two-part string-bed clamp for a bare Espruino Puck.js v2 PCB.

The housing sits on the string bed between the throat bridge and the first
cross string, in the place of a vibration dampener. A backing plate on the
other side of the string bed and two M2 countersunk screws clamp the two centre
main strings between the parts, so the sensor cannot be shaken off by impacts.

    top    — housing for the Puck PCB, TPU 95A (the retaining lip must flex)
    bottom — backing plate with captive M2 nuts, PETG or PLA

Hardware: 2 × M2×6 countersunk screws (ISO 10642 / DIN 7991), 2 × M2 hex nuts.

Coordinates (mm): string plane is z = 0, main strings run along +y and the two
centre mains are at x = ±spacing/2. The housing is on the +z side; screws pass
between the two centre mains at x = 0.

Usage:
    python clip.py                          # defaults (1.25 mm string, 12.5 mm spacing)
    python clip.py --main-spacing 12.8 --string-gauge 1.30
"""

from __future__ import annotations

import argparse
import math
from dataclasses import asdict, dataclass, fields
from pathlib import Path

import numpy as np
import trimesh
from manifold3d import Manifold

SEGMENTS = 96


@dataclass(frozen=True)
class ClipParams:
    # Racket — MEASURE these on your racket (centre-to-centre, near the throat).
    main_spacing: float = 12.5
    string_gauge: float = 1.25

    # Puck.js v2 bare PCB with CR2032 fitted (Espruino: 29 mm dia, 9 mm thick).
    pcb_diameter: float = 29.0
    pcb_stack_height: float = 9.0

    # Housing (top part).
    wall: float = 1.2
    floor: float = 1.6
    radial_clearance: float = 0.3
    # Interference: the lip presses the coin cell into its holder so that ball
    # impacts cannot interrupt battery contact.
    stack_interference: float = 0.2
    lip_width: float = 1.4
    lip_height: float = 1.0

    # Backing plate (bottom part).
    plate_width: float = 20.0  # across the strings (x)
    plate_length: float = 26.0  # along the strings (y)
    plate_thickness: float = 4.0

    # Clamp: with the screws loose, the halves stand `clamp_gap` apart around
    # the strings; tightening closes the gap and squeezes the strings by it.
    clamp_gap: float = 0.3
    groove_clearance: float = 0.0

    # M2 countersunk screws and hex nuts.
    screw_offset: float = 9.0  # ±y position of the two screws
    screw_clearance: float = 2.4
    screw_head_diameter: float = 4.0
    nut_across_flats: float = 4.2  # 4.0 nominal + printing clearance
    nut_pocket_depth: float = 1.8

    def validate(self) -> None:
        if not 9.0 <= self.main_spacing <= 16.0:
            raise ValueError(f"main_spacing {self.main_spacing} mm is outside 9–16 mm")
        if not 1.0 <= self.string_gauge <= 1.5:
            raise ValueError(f"string_gauge {self.string_gauge} mm is outside 1.0–1.5 mm")
        free_between_mains = self.main_spacing - self.string_gauge
        if self.nut_across_flats / math.cos(math.pi / 6) >= free_between_mains:
            raise ValueError("Screw nuts do not fit between the centre main strings")
        if self.plate_width <= self.main_spacing + 4:
            raise ValueError("Backing plate must extend past both centre mains")
        if self.screw_offset + self.screw_head_diameter / 2 >= self.pcb_diameter / 2:
            raise ValueError("Screw heads must lie under the PCB")


def _cylinder(height: float, radius: float, top_radius: float | None = None) -> Manifold:
    return Manifold.cylinder(height, radius, radius if top_radius is None else top_radius, SEGMENTS)


def _box(sx: float, sy: float, sz: float, cx: float, cy: float, z0: float) -> Manifold:
    return Manifold.cube([sx, sy, sz]).translate([cx - sx / 2, cy - sy / 2, z0])


def _string_grooves(p: ClipParams, length: float) -> Manifold:
    r = p.string_gauge / 2 + p.groove_clearance
    grooves = Manifold()
    for x in (-p.main_spacing / 2, p.main_spacing / 2):
        groove = (
            Manifold.cylinder(length, r, r, SEGMENTS)
            .rotate([90, 0, 0])
            .translate([x, length / 2, 0])
        )
        grooves = grooves + groove
    return grooves


def build_top(p: ClipParams) -> Manifold:
    """Housing. Underside at z = +clamp_gap/2, grooves centred on the strings."""
    p.validate()
    z0 = p.clamp_gap / 2
    inner_r = p.pcb_diameter / 2 + p.radial_clearance
    outer_r = inner_r + p.wall
    cavity_h = p.pcb_stack_height - p.stack_interference
    total_h = p.floor + cavity_h + p.lip_height

    housing = _cylinder(total_h, outer_r).translate([0, 0, z0])
    housing = housing - _cylinder(cavity_h, inner_r).translate([0, 0, z0 + p.floor])
    housing = housing - _cylinder(p.lip_height + 0.02, inner_r - p.lip_width).translate(
        [0, 0, z0 + p.floor + cavity_h - 0.01]
    )
    housing = housing - _string_grooves(p, 2 * outer_r + 2)

    # Countersunk screw holes (90°), heads flush with the cavity floor.
    sink = (p.screw_head_diameter - p.screw_clearance) / 2
    for y in (-p.screw_offset, p.screw_offset):
        hole = _cylinder(p.floor + 0.2, p.screw_clearance / 2).translate([0, y, z0 - 0.1])
        cone = _cylinder(sink + 0.01, p.screw_clearance / 2, p.screw_head_diameter / 2).translate(
            [0, y, z0 + p.floor - sink]
        )
        housing = housing - hole - cone
    return housing


def build_bottom(p: ClipParams) -> Manifold:
    """Backing plate. Top face at z = −clamp_gap/2, captive nuts underneath."""
    p.validate()
    z_top = -p.clamp_gap / 2
    plate = _box(p.plate_width, p.plate_length, p.plate_thickness, 0, 0, z_top - p.plate_thickness)
    plate = plate - _string_grooves(p, p.plate_length + 2)
    nut_circumradius = p.nut_across_flats / 2 / math.cos(math.pi / 6)
    z_bottom = z_top - p.plate_thickness
    for y in (-p.screw_offset, p.screw_offset):
        hole = _cylinder(p.plate_thickness + 0.2, p.screw_clearance / 2).translate([0, y, z_bottom - 0.1])
        nut = Manifold.cylinder(p.nut_pocket_depth + 0.01, nut_circumradius, nut_circumradius, 6).translate(
            [0, y, z_bottom - 0.01]
        )
        plate = plate - hole - nut
    return plate


def clamped_thickness(p: ClipParams) -> float:
    """Distance from the countersink to the bottom face, i.e. the screw length needed."""
    return p.floor + p.clamp_gap + p.plate_thickness


def to_trimesh(solid: Manifold) -> trimesh.Trimesh:
    mesh = solid.to_mesh()
    vertices = np.asarray(mesh.vert_properties)[:, :3]
    faces = np.asarray(mesh.tri_verts)
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=True)


def _export(solid: Manifold, path_stem: Path, flip: bool) -> trimesh.Trimesh:
    mesh = to_trimesh(solid)
    if not mesh.is_watertight:
        raise SystemExit(f"{path_stem.name}: mesh is not watertight")
    printable = mesh.copy()
    if flip:
        printable.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    printable.apply_translation([0, 0, -printable.bounds[0][2]])
    printable.export(path_stem.with_suffix(".3mf"))
    printable.export(path_stem.with_suffix(".stl"))
    return mesh


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    for f in fields(ClipParams):
        parser.add_argument(f"--{f.name.replace('_', '-')}", type=float, default=f.default)
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "out")
    args = parser.parse_args()

    params = ClipParams(**{f.name: getattr(args, f.name) for f in fields(ClipParams)})
    args.out.mkdir(parents=True, exist_ok=True)
    tag = f"s{params.main_spacing:g}-g{params.string_gauge:g}"
    # Top prints lip-down (the snap lip needs no support); bottom prints nut-pockets-down.
    top = _export(build_top(params), args.out / f"puck-clamp-top-{tag}", flip=True)
    bottom = _export(build_bottom(params), args.out / f"puck-clamp-bottom-{tag}", flip=False)

    print(f"Wrote puck-clamp-top/bottom-{tag}.3mf/.stl to {args.out}")
    print(f"Top {top.extents.round(1)} mm, {top.volume / 1000:.2f} cm³ (TPU 95A)")
    print(f"Bottom {bottom.extents.round(1)} mm, {bottom.volume / 1000:.2f} cm³ (PETG)")
    print(f"Screw length {clamped_thickness(params):.1f} mm → M2×6 countersunk ends flush with the plate")
    print(f"Parameters: {asdict(params)}")


if __name__ == "__main__":
    main()
