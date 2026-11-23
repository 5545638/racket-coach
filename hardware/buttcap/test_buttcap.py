"""Geometry checks for the Puck butt cap. Run: pytest hardware/buttcap"""

import pytest

from buttcap import ButtCapParams, build, build_racket_side, to_trimesh


def test_cap_is_a_printable_solid() -> None:
    for part in (build(ButtCapParams()), build_racket_side(ButtCapParams())):
        mesh = to_trimesh(part)
        assert mesh.is_watertight and mesh.is_volume


def test_nothing_sticks_out_past_the_flange() -> None:
    p = ButtCapParams()
    mesh = to_trimesh(build(p))
    assert mesh.extents[0] == pytest.approx(p.flange_width, abs=0.01)
    assert mesh.extents[1] == pytest.approx(p.flange_length, abs=0.01)


def test_fit_test_part_matches_stock_cap_height() -> None:
    p = ButtCapParams()
    mesh = to_trimesh(build_racket_side(p))
    assert mesh.extents[2] == pytest.approx(p.flange_thickness + p.collar_depth, abs=0.01)


def test_rejects_a_cup_wider_than_the_flange() -> None:
    with pytest.raises(ValueError, match="stick out"):
        build(ButtCapParams(flange_width=30.0, collar_width=25.0))
