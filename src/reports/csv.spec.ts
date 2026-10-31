import { csvCell, csvLine, csvMoney } from './csv.js';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvLine(['Hasan, Rakib', 'say "hi"', 'a\nb', null, 3])).toBe('"Hasan, Rakib","say ""hi""","a\nb",,3\r\n');
  });

  it('defuses formulas but leaves numbers and phones alone', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell('-150.00')).toBe('-150.00');
    expect(csvCell('+8801711000000')).toBe('+8801711000000');
  });

  it('formats money in whole taka with two decimals', () => {
    expect(csvMoney(150000)).toBe('1500.00');
    expect(csvMoney(-5050)).toBe('-50.50');
  });
});
