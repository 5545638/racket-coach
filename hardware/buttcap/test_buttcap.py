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
        build(ButtCapParams(flange_width=31.0, flange_length=30.0, collar_width=28.0, collar_length=25.0))


def test_lid_snaps_onto_the_cup_without_colliding() -> None:
    from buttcap import build_lid, cup_top

    p = ButtCapParams()
    cap, lid = build(p), build_lid(p)
    lid_mesh = to_trimesh(lid)
    assert lid_mesh.is_watertight and lid_mesh.is_volume
    # Seated, the lid only touches the cup; the bead sits in the groove, not in the wall.
    assert (cap ^ lid).volume() < 0.05
    # The lid sits on the rim and stays within the 40 mm grip.
    assert lid_mesh.bounds[0][2] == pytest.approx(cup_top(p) - p.lid_sleeve, abs=0.01)
    assert lid_mesh.extents[0] < 40


def test_lid_carries_the_engraved_letter() -> None:
    from buttcap import build_lid

    plain = to_trimesh(build_lid(ButtCapParams(letter="")))
    marked = to_trimesh(build_lid(ButtCapParams()))
    assert marked.volume < plain.volume - 20  # mm³ removed by the H
